import { createHmac } from "node:crypto";

import type { CorpusRecord, JsonValue, Label, Link, RawRecord } from "../normalize/index.js";
import { tokenize } from "./tokenize.js";
import { PolicyResolver, type Disposition } from "./policy.js";

/**
 * Path-aware sanitization walk. Applies a `PolicyResolver` at every node, falling back to the
 * SCHEMA.md built-in disposition table when `decide(path)` returns `default`.
 *
 * Paths use the ADR-0009 dotted language: `inputs.user.email`, `inputs.items[*].sku`,
 * `labels[*].key`. Array elements collapse to `[*]` so the inventory stays bounded.
 */

/** Sentinel for dropped fields — the parent object omits the key. */
const DROP = Symbol("trace-grab:drop");

/** Fields that pass verbatim by default (SCHEMA.md disposition table, ADR-0005). */
const BUILTIN_PASS_VERBATIM: Record<string, true> = {
  name: true,
  kind: true,
  status: true,
  "error.kind": true,
  start: true,
  end: true,
  "labels[*].key": true,
  "labels[*].value": true,
  "source.vendor": true,
};

/**
 * Derive a stable per-corpus time offset (seconds) from the salt (ADR-0006/ADR-0009).
 * Same salt → same offset across batches, so shifted timestamps are consistent.
 */
function deriveTimeOffsetSeconds(salt: Buffer): number {
  return createHmac("sha256", salt).update("trace-grab-time-shift").digest().readUInt32BE(0);
}

/** Apply the salt-derived constant offset to an ISO-8601 timestamp. Preserves intervals and ordering. */
function shiftTimestamp(value: string, salt: Buffer): string {
  const ms = Date.parse(value);
  return new Date(ms - deriveTimeOffsetSeconds(salt) * 1000).toISOString();
}

/** Resolve a required string field. `drop` → tokenize (can't remove a required field; fail closed). */
function resolveString(value: string, path: string, resolver: PolicyResolver, salt: Buffer): string {
  const d = resolver.decide(path);
  switch (d) {
    case "reveal":
      return value;
    case "tokenize":
      return tokenize(value, salt);
    case "drop":
      return tokenize(value, salt);
    case "default":
      return path in BUILTIN_PASS_VERBATIM ? value : tokenize(value, salt);
  }
}

/** Resolve a required timestamp field. Honours `time: shift` on `default`. */
function resolveTimestamp(value: string, path: string, resolver: PolicyResolver, salt: Buffer): string {
  const d = resolver.decide(path);
  if (d === "reveal") return value;
  if (d === "tokenize" || d === "drop") return tokenize(value, salt);
  // default
  if (resolver.time === "shift") return shiftTimestamp(value, salt);
  return value;
}

/**
 * Common walk for a JSON value under a given path. Returns `DROP` when the field should be
 * removed from its parent object.
 *
 * Containers (objects/arrays) always walk children regardless of their own disposition —
 * a child path may have a more specific rule that overrides (e.g. `drop: inputs.email`
 * carves out of `reveal: inputs.**`). Only leaf values apply the disposition directly.
 */
function sanitizeValue(
  value: JsonValue,
  path: string,
  d: Disposition,
  resolver: PolicyResolver,
  salt: Buffer,
): JsonValue | typeof DROP {
  if (d === "drop") return DROP;

  // Leaf values: apply the disposition directly.
  if (typeof value === "string") {
    if (d === "reveal") return value;
    if (d === "default" && path in BUILTIN_PASS_VERBATIM) return value;
    return tokenize(value, salt);
  }
  if (value === null || typeof value !== "object") return value;

  // Containers: walk children. Each child resolves its own disposition via decide(childPath).
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeJsonValue(item, `${path}[*]`, resolver, salt))
      .filter((v): v is JsonValue => v !== DROP);
  }

  const out: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    const result = sanitizeJsonValue(item, `${path}.${key}`, resolver, salt);
    if (result !== DROP) out[key] = result;
  }
  return out;
}

/** Walk a JSON value at `path`. Returns `DROP` if the field should be removed. */
function sanitizeJsonValue(
  value: JsonValue,
  path: string,
  resolver: PolicyResolver,
  salt: Buffer,
): JsonValue | typeof DROP {
  return sanitizeValue(value, path, resolver.decide(path), resolver, salt);
}

/** Walk a required JSON value (inputs, outputs, label.value). `drop` → `default` (can't remove). */
function sanitizeRequiredValue(
  value: JsonValue,
  path: string,
  resolver: PolicyResolver,
  salt: Buffer,
): JsonValue {
  const d = resolver.decide(path);
  const result = sanitizeValue(value, path, d === "drop" ? "default" : d, resolver, salt);
  return result === DROP ? value : result;
}

/** Walk a bag (attributes, unmapped, link.attributes). Individual keys can be dropped. */
function sanitizeBag(
  bag: Record<string, JsonValue>,
  pathPrefix: string,
  resolver: PolicyResolver,
  salt: Buffer,
): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(bag)) {
    const result = sanitizeJsonValue(item, `${pathPrefix}.${key}`, resolver, salt);
    if (result !== DROP) out[key] = result;
  }
  return out;
}

function sanitizeLabel(label: Label, resolver: PolicyResolver, salt: Buffer): Label {
  return {
    key: resolveString(label.key, "labels[*].key", resolver, salt),
    value: sanitizeRequiredValue(label.value, "labels[*].value", resolver, salt),
    comment: label.comment === null ? null : resolveString(label.comment, "labels[*].comment", resolver, salt),
  };
}

function sanitizeLink(link: Link, resolver: PolicyResolver, salt: Buffer): Link {
  return {
    trace_id: resolveString(link.trace_id, "links[*].trace_id", resolver, salt),
    span_id: resolveString(link.span_id, "links[*].span_id", resolver, salt),
    attributes: sanitizeBag(link.attributes, "links[*].attributes", resolver, salt),
  };
}

/**
 * Pure `RawRecord -> CorpusRecord`, one record at a time, no cross-record state (SCHEMA.md).
 * When no resolver is supplied, the built-in ADR-0005 defaults apply — identical to a zero-config
 * run with no `tracegrab.yaml`.
 */
export function sanitizeRecord(
  record: RawRecord,
  salt: Buffer,
  resolver: PolicyResolver = new PolicyResolver(),
): CorpusRecord {
  return {
    id: resolveString(record.id, "id", resolver, salt),
    trace_id: resolveString(record.trace_id, "trace_id", resolver, salt),
    parent_id:
      record.parent_id === null ? null : resolveString(record.parent_id, "parent_id", resolver, salt),
    name: resolveString(record.name, "name", resolver, salt),
    kind: resolveString(record.kind, "kind", resolver, salt),
    start: resolveTimestamp(record.start, "start", resolver, salt),
    end: record.end === null ? null : resolveTimestamp(record.end, "end", resolver, salt),
    status: record.status,
    error:
      record.error === null
        ? null
        : {
            kind: resolveString(record.error.kind, "error.kind", resolver, salt),
            message: resolveString(record.error.message, "error.message", resolver, salt),
          },
    inputs: sanitizeRequiredValue(record.inputs, "inputs", resolver, salt),
    outputs: sanitizeRequiredValue(record.outputs, "outputs", resolver, salt),
    attributes: sanitizeBag(record.attributes, "attributes", resolver, salt),
    labels: record.labels.map((label) => sanitizeLabel(label, resolver, salt)),
    links: record.links.map((link) => sanitizeLink(link, resolver, salt)),
    unmapped: sanitizeBag(record.unmapped, "unmapped", resolver, salt),
    source: { vendor: resolveString(record.source.vendor, "source.vendor", resolver, salt) },
  };
}
