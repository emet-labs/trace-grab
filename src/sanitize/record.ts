import { createHmac } from "node:crypto";

import type { CorpusRecord, JsonValue, Label, Link, RawRecord } from "../normalize/index.js";
import { tokenize } from "./tokenize.js";
import { PolicyResolver, type Disposition } from "./policy.js";
import type { OnInventory } from "./inventory.js";

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
 * Optional side-channel invoked with every `(token, originalValue)` pair the walk produces
 * (ADR-0006). The `grab` flow uses it to populate the local reverse keymap; when omitted the
 * walk is pure and byte-identical to a run with no keymap — `check` and the tests rely on that.
 */
export type OnToken = (token: string, value: string) => void;

/** Tokenize a value and announce the pair on the side-channel (when one is attached). */
function tokenizeWithCallback(
  value: string,
  salt: Buffer,
  onToken?: OnToken,
): string {
  const token = tokenize(value, salt);
  onToken?.(token, value);
  return token;
}

/**
 * Derive a stable per-corpus time offset (seconds) from the salt (ADR-0006/ADR-0009).
 * Same salt → same offset across batches, so shifted timestamps are consistent.
 */
function deriveTimeOffsetSeconds(salt: Buffer): number {
  return createHmac("sha256", salt).update("time-shift").digest().readUInt32BE(0);
}

/** Apply the salt-derived constant offset to an ISO-8601 timestamp. Preserves intervals and ordering. */
function shiftTimestamp(value: string, salt: Buffer): string {
  const ms = Date.parse(value);
  return new Date(ms - deriveTimeOffsetSeconds(salt) * 1000).toISOString();
}

/** Resolve a required string field. `drop` → tokenize (can't remove a required field; fail closed). */
function resolveString(
  value: string,
  path: string,
  resolver: PolicyResolver,
  salt: Buffer,
  onToken?: OnToken,
  onInventory?: OnInventory,
): string {
  const d = resolver.decide(path);
  switch (d) {
    case "reveal":
      onInventory?.(path, "reveal", value);
      return value;
    case "tokenize": {
      const token = tokenizeWithCallback(value, salt, onToken);
      onInventory?.(path, "tokenize", token);
      return token;
    }
    case "drop": {
      // Required field — can't remove, so fail closed to tokenize. The effective disposition
      // applied to the value is `tokenize`, which is what the inventory records.
      const token = tokenizeWithCallback(value, salt, onToken);
      onInventory?.(path, "tokenize", token);
      return token;
    }
    case "default": {
      if (path in BUILTIN_PASS_VERBATIM) {
        onInventory?.(path, "default", value);
        return value;
      }
      const token = tokenizeWithCallback(value, salt, onToken);
      onInventory?.(path, "default", token);
      return token;
    }
  }
}

/** Resolve a required timestamp field. Honours `time: shift` on `default`. */
function resolveTimestamp(
  value: string,
  path: string,
  resolver: PolicyResolver,
  salt: Buffer,
  onToken?: OnToken,
  onInventory?: OnInventory,
): string {
  const d = resolver.decide(path);
  if (d === "reveal") {
    onInventory?.(path, "reveal", value);
    return value;
  }
  if (d === "tokenize" || d === "drop") {
    const token = tokenizeWithCallback(value, salt, onToken);
    onInventory?.(path, "tokenize", token);
    return token;
  }
  // default
  if (resolver.time === "shift") {
    const shifted = shiftTimestamp(value, salt);
    onInventory?.(path, "default", shifted);
    return shifted;
  }
  onInventory?.(path, "default", value);
  return value;
}

/**
 * Common walk for a JSON value under a given path. Returns `DROP` when the field should be
 * removed, a sanitized leaf otherwise. Containers recurse; array elements collapse to `[*]`.
 */
function sanitizeValue(
  value: JsonValue,
  path: string,
  d: Disposition,
  resolver: PolicyResolver,
  salt: Buffer,
  onToken?: OnToken,
  onInventory?: OnInventory,
  trail: Set<object> = new Set(),
): JsonValue | typeof DROP {
  if (d === "drop") {
    onInventory?.(path, "drop", null);
    return DROP;
  }

  // Leaf values: apply the disposition directly.
  if (typeof value === "string") {
    if (d === "reveal") {
      onInventory?.(path, "reveal", value);
      return value;
    }
    if (d === "default" && path in BUILTIN_PASS_VERBATIM) {
      onInventory?.(path, "default", value);
      return value;
    }
    const token = tokenizeWithCallback(value, salt, onToken);
    // `d` is `tokenize` (explicit policy) or `default` (built-in string rule); the rendered
    // example is the token the walk actually produced.
    onInventory?.(path, d, token);
    return token;
  }
  if (value === null || typeof value !== "object") {
    // Pass-through primitive (number/boolean/null). Rendered example is the stringified value.
    onInventory?.(path, d, value === null ? "null" : String(value));
    return value;
  }

  // Cycle guard (issue #7, AC #1): an ancestor-trail of object identities. A cyclic `inputs`
  // object would recurse forever; reject it with a path-naming error instead of hanging. The
  // trail holds only ancestors (add before recursing, delete after), so a shared sub-object
  // referenced from two sibling paths — a DAG, not a cycle — is still allowed.
  if (trail.has(value)) {
    throw new Error(`cycle detected at ${path}: circular object reference`);
  }
  trail.add(value);
  try {
    // Containers: walk children. Each child resolves its own disposition via decide(childPath).
    if (Array.isArray(value)) {
      return value
        .map((item) =>
          sanitizeJsonValue(item, `${path}[*]`, resolver, salt, onToken, onInventory, trail),
        )
        .filter((v): v is JsonValue => v !== DROP);
    }

    const out: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      const result = sanitizeJsonValue(
        item,
        `${path}.${key}`,
        resolver,
        salt,
        onToken,
        onInventory,
        trail,
      );
      if (result !== DROP) out[key] = result;
    }
    return out;
  } finally {
    trail.delete(value);
  }
}

function sanitizeJsonValue(
  value: JsonValue,
  path: string,
  resolver: PolicyResolver,
  salt: Buffer,
  onToken?: OnToken,
  onInventory?: OnInventory,
  trail: Set<object> = new Set(),
): JsonValue | typeof DROP {
  return sanitizeValue(value, path, resolver.decide(path), resolver, salt, onToken, onInventory, trail);
}

/** Walk a required JSON value (inputs, outputs, label.value). `drop` → `default` (can't remove). */
function sanitizeRequiredValue(
  value: JsonValue,
  path: string,
  resolver: PolicyResolver,
  salt: Buffer,
  onToken?: OnToken,
  onInventory?: OnInventory,
  trail: Set<object> = new Set(),
): JsonValue {
  const d = resolver.decide(path);
  const result = sanitizeValue(
    value,
    path,
    d === "drop" ? "default" : d,
    resolver,
    salt,
    onToken,
    onInventory,
    trail,
  );
  return result === DROP ? value : result;
}

/** Walk a bag (attributes, unmapped, link.attributes). Individual keys can be dropped. */
function sanitizeBag(
  bag: Record<string, JsonValue>,
  pathPrefix: string,
  resolver: PolicyResolver,
  salt: Buffer,
  onToken?: OnToken,
  onInventory?: OnInventory,
  trail: Set<object> = new Set(),
): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(bag)) {
    const result = sanitizeJsonValue(
      item,
      `${pathPrefix}.${key}`,
      resolver,
      salt,
      onToken,
      onInventory,
      trail,
    );
    if (result !== DROP) out[key] = result;
  }
  return out;
}

function sanitizeLabel(
  label: Label,
  resolver: PolicyResolver,
  salt: Buffer,
  onToken?: OnToken,
  onInventory?: OnInventory,
): Label {
  return {
    key: resolveString(label.key, "labels[*].key", resolver, salt, onToken, onInventory),
    value: sanitizeRequiredValue(label.value, "labels[*].value", resolver, salt, onToken, onInventory),
    comment:
      label.comment === null
        ? null
        : resolveString(label.comment, "labels[*].comment", resolver, salt, onToken, onInventory),
  };
}

function sanitizeLink(
  link: Link,
  resolver: PolicyResolver,
  salt: Buffer,
  onToken?: OnToken,
  onInventory?: OnInventory,
): Link {
  return {
    trace_id: resolveString(link.trace_id, "links[*].trace_id", resolver, salt, onToken, onInventory),
    span_id: resolveString(link.span_id, "links[*].span_id", resolver, salt, onToken, onInventory),
    attributes: sanitizeBag(link.attributes, "links[*].attributes", resolver, salt, onToken, onInventory),
  };
}

/**
 * Pure `RawRecord -> CorpusRecord`, one record at a time, no cross-record state (SCHEMA.md).
 * When no resolver is supplied, the built-in ADR-0005 defaults apply — identical to a zero-config
 * run with no `tracegrab.yaml`.
 *
 * The optional `onToken` side-channel (ADR-0006) announces every `(token, value)` pair the walk
 * tokenizes, so the `grab` flow can populate the local reverse keymap without making this function
 * impure: the returned `CorpusRecord` is identical whether or not `onToken` is supplied. Omitting it
 * (the `check` flow and every test) keeps behaviour byte-identical to a no-keymap run.
 *
 * The optional `onInventory` side-channel (issue #7) announces every leaf decision the walk makes
 * — `(path, disposition, renderedExample)` — so a {@link PathInventory} can accumulate per-path
 * stats. It mirrors `onToken`: the returned `CorpusRecord` is byte-identical whether or not an
 * inventory is attached, so the inventory is a pure observer of decisions already made.
 */
export function sanitizeRecord(
  record: RawRecord,
  salt: Buffer,
  resolver: PolicyResolver = new PolicyResolver(),
  onToken?: OnToken,
  onInventory?: OnInventory,
): CorpusRecord {
  // `status` is an enum that always passes verbatim (POLICY.md: not droppable, not free text).
  // It is intentionally NOT routed through `resolveString` (which would fail-close to tokenize on
  // a `drop` policy); the direct assignment enforces "always pass." Announce the decision to the
  // inventory observer so the path set is complete — disposition `default`, example = real value,
  // mirroring `resolveString`'s builtin pass-verbatim recording for `name`/`kind`.
  onInventory?.("status", "default", record.status);
  return {
    id: resolveString(record.id, "id", resolver, salt, onToken, onInventory),
    trace_id: resolveString(record.trace_id, "trace_id", resolver, salt, onToken, onInventory),
    parent_id:
      record.parent_id === null
        ? null
        : resolveString(record.parent_id, "parent_id", resolver, salt, onToken, onInventory),
    name: resolveString(record.name, "name", resolver, salt, onToken, onInventory),
    kind: resolveString(record.kind, "kind", resolver, salt, onToken, onInventory),
    start: resolveTimestamp(record.start, "start", resolver, salt, onToken, onInventory),
    end:
      record.end === null
        ? null
        : resolveTimestamp(record.end, "end", resolver, salt, onToken, onInventory),
    status: record.status,
    error:
      record.error === null
        ? null
        : {
            kind: resolveString(record.error.kind, "error.kind", resolver, salt, onToken, onInventory),
            message: resolveString(record.error.message, "error.message", resolver, salt, onToken, onInventory),
          },
    inputs: sanitizeRequiredValue(record.inputs, "inputs", resolver, salt, onToken, onInventory),
    outputs: sanitizeRequiredValue(record.outputs, "outputs", resolver, salt, onToken, onInventory),
    attributes: sanitizeBag(record.attributes, "attributes", resolver, salt, onToken, onInventory),
    labels: record.labels.map((label) => sanitizeLabel(label, resolver, salt, onToken, onInventory)),
    links: record.links.map((link) => sanitizeLink(link, resolver, salt, onToken, onInventory)),
    unmapped: sanitizeBag(record.unmapped, "unmapped", resolver, salt, onToken, onInventory),
    source: {
      vendor: resolveString(record.source.vendor, "source.vendor", resolver, salt, onToken, onInventory),
    },
  };
}
