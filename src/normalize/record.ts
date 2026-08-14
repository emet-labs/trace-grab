/**
 * trace-corpus-v1 record shape. Normative spec: docs/SCHEMA.md.
 *
 * RawRecord and CorpusRecord are structurally identical — sanitization replaces string leaves
 * outside the pass-verbatim fields with tokens, but never changes the shape. They're kept as
 * distinct named types so a function's signature says which value-space it operates in.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type SpanStatus = "unset" | "ok" | "error";

export interface SpanError {
  kind: string;
  message: string;
}

export interface Label {
  key: string;
  value: JsonValue;
  comment: string | null;
}

export interface Link {
  trace_id: string;
  span_id: string;
  attributes: Record<string, JsonValue>;
}

export interface RecordSource {
  vendor: string;
}

interface SpanRecord {
  id: string;
  trace_id: string;
  parent_id: string | null;
  name: string;
  kind: string;
  start: string;
  end: string | null;
  status: SpanStatus;
  error: SpanError | null;
  inputs: JsonValue;
  outputs: JsonValue;
  attributes: Record<string, JsonValue>;
  labels: Label[];
  links: Link[];
  unmapped: Record<string, JsonValue>;
  source: RecordSource;
}

/** One span as normalized from a vendor export, before sanitization. String leaves hold the vendor's original values. */
export type RawRecord = SpanRecord;

/** One span after the sanitization walk. String leaves outside the pass-verbatim fields have become `TOK_<10 hex>` tokens. */
export type CorpusRecord = SpanRecord;
