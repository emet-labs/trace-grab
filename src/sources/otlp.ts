import { readFileSync } from "node:fs";

import type {
  JsonValue,
  Label,
  Link,
  RawRecord,
  SpanError,
  SpanStatus,
} from "../normalize/index.js";

/**
 * OTLP/JSON export parser. Walks `resourceSpans[].scopeSpans[].spans[]` and maps each span
 * onto a `RawRecord`. Per ADR-0004 ("structural normalization only — when in doubt, do not
 * interpret"), gen_ai.* attributes stay in `attributes` unless their meaning is unambiguous;
 * the default is to preserve them verbatim rather than guess an inputs/outputs mapping.
 *
 * @see docs/adr/0004-structural-normalization-only.md
 * @see docs/adr/0010-span-shaped-records-and-opaque-tokens.md
 */

/** OTLP AnyValue — one of these branches is set. */
interface AnyValue {
  stringValue?: string;
  intValue?: string;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values?: AnyValue[] };
  kvlistValue?: { values?: Array<{ key: string; value: AnyValue }> };
  bytesValue?: string;
}

/** OTLP key/value pair. */
interface KeyValue {
  key: string;
  value: AnyValue;
}

/** OTLP span link. */
interface OtlpLink {
  traceId?: string;
  spanId?: string;
  attributes?: KeyValue[];
}

/** OTLP span status. */
interface OtlpStatus {
  code?: number;
  message?: string;
}

/** OTLP span. */
interface OtlpSpan {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  name?: string;
  kind?: number;
  startTimeUnixNano?: string;
  endTimeUnixNano?: string;
  attributes?: KeyValue[];
  links?: OtlpLink[];
  status?: OtlpStatus;
  [key: string]: unknown;
}

/** OTLP scope (instrumentation library). */
interface OtlpScope {
  name?: string;
  version?: string;
  attributes?: KeyValue[];
}

interface ScopeSpans {
  scope?: OtlpScope;
  spans?: OtlpSpan[];
}

interface ResourceSpans {
  resource?: { attributes?: KeyValue[] };
  scopeSpans?: ScopeSpans[];
}

interface OtlpRoot {
  resourceSpans?: ResourceSpans[];
}

const SPAN_KIND_NAMES: Record<number, string> = {
  0: "internal",
  1: "server",
  2: "client",
  3: "producer",
  4: "consumer",
};

/** Parse an OTLP AnyValue into a JSON value. */
function parseAnyValue(value: AnyValue): JsonValue {
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.intValue !== undefined) return Number.parseInt(value.intValue, 10);
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.boolValue !== undefined) return value.boolValue;
  if (value.arrayValue?.values !== undefined) {
    return value.arrayValue.values.map((v) => parseAnyValue(v));
  }
  if (value.kvlistValue?.values !== undefined) {
    const out: Record<string, JsonValue> = {};
    for (const entry of value.kvlistValue.values) {
      out[entry.key] = parseAnyValue(entry.value);
    }
    return out;
  }
  if (value.bytesValue !== undefined) return value.bytesValue;
  return null;
}

/** Parse an array of OTLP KeyValue pairs into a nested attribute record. */
function parseAttributes(attrs: KeyValue[] | undefined): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  if (!attrs) return out;
  for (const { key, value } of attrs) {
    out[key] = parseAnyValue(value);
  }
  return out;
}

/** Convert an OTLP nanosecond timestamp (string) to ISO-8601 UTC using BigInt arithmetic. */
function nanosToIso(nanos: string | undefined): string | null {
  if (nanos === undefined || nanos.length === 0) return null;
  const ns = BigInt(nanos);
  const ms = Number(ns / 1_000_000n);
  return new Date(ms).toISOString();
}

/** Map OTLP status code onto the schema's three-value model. */
function mapStatus(status: OtlpStatus | undefined): {
  status: SpanStatus;
  error: SpanError | null;
} {
  const code = status?.code ?? 0;
  if (code === 1) return { status: "ok", error: null };
  if (code === 2) {
    return {
      status: "error",
      error: { kind: "error", message: status?.message ?? "" },
    };
  }
  return { status: "unset", error: null };
}

/** Map OTLP links onto the schema Link shape. */
function mapLinks(links: OtlpLink[] | undefined): Link[] {
  if (!links) return [];
  return links.map((link) => ({
    trace_id: link.traceId ?? "",
    span_id: link.spanId ?? "",
    attributes: parseAttributes(link.attributes),
  }));
}

/** Reserved top-level keys on an OTLP span — everything else goes to `unmapped`. */
const RECOGNIZED_SPAN_KEYS: Record<string, true> = {
  traceId: true,
  spanId: true,
  parentSpanId: true,
  name: true,
  kind: true,
  startTimeUnixNano: true,
  endTimeUnixNano: true,
  status: true,
  attributes: true,
  links: true,
};

/** Collect unrecognized span fields verbatim into `unmapped`. */
function collectUnmapped(span: OtlpSpan): Record<string, JsonValue> {
  const unmapped: Record<string, JsonValue> = {};
  for (const [key, raw] of Object.entries(span)) {
    if (key in RECOGNIZED_SPAN_KEYS) continue;
    unmapped[key] = (raw as JsonValue) ?? null;
  }
  return unmapped;
}

/** Map a single OTLP span onto a RawRecord. */
function mapSpan(
  span: OtlpSpan,
  resourceAttrs: Record<string, JsonValue>,
  scopeAttrs: Record<string, JsonValue>,
  scopeName?: string,
  scopeVersion?: string,
): RawRecord {
  const { status, error } = mapStatus(span.status);

  const attributes: Record<string, JsonValue> = {};
  if (Object.keys(resourceAttrs).length > 0) attributes.resource = resourceAttrs;
  const scopeRecord: Record<string, JsonValue> = { ...scopeAttrs };
  if (scopeName !== undefined) scopeRecord.name = scopeName;
  if (scopeVersion !== undefined) scopeRecord.version = scopeVersion;
  if (Object.keys(scopeRecord).length > 0) attributes.scope = scopeRecord;
  Object.assign(attributes, parseAttributes(span.attributes));

  const parentId =
    span.parentSpanId && span.parentSpanId.length > 0 ? span.parentSpanId : null;

  return {
    id: span.spanId ?? "",
    trace_id: span.traceId ?? "",
    parent_id: parentId,
    name: span.name ?? "",
    kind: SPAN_KIND_NAMES[span.kind ?? -1] ?? String(span.kind ?? ""),
    start: nanosToIso(span.startTimeUnixNano) ?? "",
    end: nanosToIso(span.endTimeUnixNano),
    status,
    error,
    inputs: {},
    outputs: {},
    attributes,
    labels: [] as Label[],
    links: mapLinks(span.links),
    unmapped: collectUnmapped(span),
    source: { vendor: "otlp" },
  };
}

/** Read an OTLP/JSON export file and return one RawRecord per span. */
export function readOtlpJson(path: string): RawRecord[] {
  const text = readFileSync(path, "utf8");
  const root = JSON.parse(text) as OtlpRoot;
  const records: RawRecord[] = [];
  for (const rs of root.resourceSpans ?? []) {
    const resourceAttrs = parseAttributes(rs.resource?.attributes);
    for (const ss of rs.scopeSpans ?? []) {
      const scopeAttrs = parseAttributes(ss.scope?.attributes);
      for (const span of ss.spans ?? []) {
        records.push(
          mapSpan(
            span,
            resourceAttrs,
            scopeAttrs,
            ss.scope?.name,
            ss.scope?.version,
          ),
        );
      }
    }
  }
  return records;
}

/** Heuristic: does this JSON file look like an OTLP export? */
export function looksLikeOtlp(path: string): boolean {
  const text = readFileSync(path, "utf8").trimStart();
  if (!text.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(text) as OtlpRoot;
    return Array.isArray(parsed.resourceSpans);
  } catch {
    return false;
  }
}
