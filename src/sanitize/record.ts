import type { CorpusRecord, JsonValue, Label, Link, RawRecord } from "../normalize/index.js";
import { tokenize } from "./tokenize.js";

/**
 * Dispositions per SCHEMA.md, applied with no policy file — the deny-by-default built-ins only
 * (ADR-0005). Object/array keys pass; string leaves tokenize; numbers, booleans, and null pass.
 */
function sanitizeJsonValue(value: JsonValue, salt: Buffer): JsonValue {
  if (typeof value === "string") return tokenize(value, salt);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeJsonValue(item, salt));

  const out: { [key: string]: JsonValue } = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = sanitizeJsonValue(item, salt);
  }
  return out;
}

function sanitizeBag(bag: Record<string, JsonValue>, salt: Buffer): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(bag)) {
    out[key] = sanitizeJsonValue(value, salt);
  }
  return out;
}

function sanitizeLabel(label: Label, salt: Buffer): Label {
  return {
    key: label.key,
    value: label.value,
    comment: label.comment === null ? null : tokenize(label.comment, salt),
  };
}

function sanitizeLink(link: Link, salt: Buffer): Link {
  return {
    trace_id: tokenize(link.trace_id, salt),
    span_id: tokenize(link.span_id, salt),
    attributes: sanitizeBag(link.attributes, salt),
  };
}

/** Pure `RawRecord -> CorpusRecord`, one record at a time, no cross-record state (SCHEMA.md). */
export function sanitizeRecord(record: RawRecord, salt: Buffer): CorpusRecord {
  return {
    id: tokenize(record.id, salt),
    trace_id: tokenize(record.trace_id, salt),
    parent_id: record.parent_id === null ? null : tokenize(record.parent_id, salt),
    name: record.name,
    kind: record.kind,
    start: record.start,
    end: record.end,
    status: record.status,
    error:
      record.error === null
        ? null
        : { kind: record.error.kind, message: tokenize(record.error.message, salt) },
    inputs: sanitizeJsonValue(record.inputs, salt),
    outputs: sanitizeJsonValue(record.outputs, salt),
    attributes: sanitizeBag(record.attributes, salt),
    labels: record.labels.map((label) => sanitizeLabel(label, salt)),
    links: record.links.map((link) => sanitizeLink(link, salt)),
    unmapped: sanitizeBag(record.unmapped, salt),
    source: { vendor: record.source.vendor },
  };
}
