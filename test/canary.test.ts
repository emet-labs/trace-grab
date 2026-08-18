/**
 * Canary leak suite (ADR-0013 / issue #15).
 *
 * Proves the deny-by-default claim by injecting unique markers (`CANARY-<uuid>`) at every
 * reachable position where a string leaf could appear, then asserting zero survive sanitization.
 *
 * Mutation verification:
 *   To confirm this suite catches bypasses, temporarily replace `sanitizeRecord`'s body in
 *   `src/sanitize/record.ts` with `return record;` (identity) and re-run `bun test canary`.
 *   The generic, langsmith, and otlp canary tests MUST go red — the keys and negative tests
 *   are the only ones that stay green, because they assert intentional presence.
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonValue, RawRecord } from "../src/normalize/index.js";
import { sanitizeRecord } from "../src/sanitize/index.js";
import { readLangSmithExport, readOtlpJson } from "../src/sources/index.js";

/** Fixed 32-byte test salt — deterministic so assertions are stable (ADR-0006). */
const SALT = Buffer.alloc(32, 7);

/** Marker prefix every canary carries; greppable and unlikely to collide with real data. */
const CANARY_PREFIX = "CANARY-";

/** Fresh unique canary string. */
function canary(): string {
  return `${CANARY_PREFIX}${randomUUID()}`;
}

/**
 * Recursively collect every string VALUE (not key) reachable from a JSON tree, returning the
 * list of those that still contain the canary prefix. Keys are deliberately excluded here so
 * the scan reflects only tokenizable leaves — keys pass verbatim by design (ADR-0005) and are
 * asserted separately by the keys test.
 */
function leakedCanaries(value: JsonValue): string[] {
  const hits: string[] = [];

  function walk(node: JsonValue): void {
    if (typeof node === "string") {
      if (node.includes(CANARY_PREFIX)) hits.push(node);
      return;
    }
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    for (const child of Object.values(node)) walk(child);
  }

  walk(value);
  return hits;
}

/**
 * Collect every object KEY reachable from a JSON tree that contains the canary prefix. Used by
 * the keys test to assert ADR-0005: keys are intentionally preserved, not silently dropped.
 */
function survivingCanaryKeys(value: JsonValue): string[] {
  const keys: string[] = [];

  function walk(node: JsonValue): void {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if (k.includes(CANARY_PREFIX)) keys.push(k);
      walk(v);
    }
  }

  walk(value);
  return keys;
}

/**
 * Scan every string-bearing field of a sanitized CorpusRecord for leaked canaries, excluding
 * object keys (which are intentionally verbatim). Returns the list of leaked canary strings.
 *
 * The pass-verbatim scalar fields (name, kind, start, end, status, error.kind, source.vendor,
 * labels[].key, labels[].value) are excluded from the leak scan by default — the negative test
 * exercises those explicitly. This function scans the tokenizable fields only.
 */
function scanRecordForLeaks(record: RawRecord): string[] {
  const hits: string[] = [];

  // Tokenized scalar id fields.
  for (const f of ["id", "trace_id"] as const) {
    if (record[f].includes(CANARY_PREFIX)) hits.push(record[f]);
  }
  if (record.parent_id !== null && record.parent_id.includes(CANARY_PREFIX)) {
    hits.push(record.parent_id);
  }
  // error.message is tokenized; error.kind passes verbatim (excluded here).
  if (record.error !== null && record.error.message.includes(CANARY_PREFIX)) {
    hits.push(record.error.message);
  }

  // Nested JSON bags — scan values only, not keys.
  for (const bag of [record.inputs, record.outputs]) hits.push(...leakedCanaries(bag));
  hits.push(...leakedCanaries(record.attributes));
  hits.push(...leakedCanaries(record.unmapped));

  // labels[].comment is tokenized; key and value pass verbatim (excluded here).
  for (const label of record.labels) {
    if (label.comment !== null && label.comment.includes(CANARY_PREFIX)) {
      hits.push(label.comment);
    }
  }

  // links[].trace_id / span_id are tokenized; link attributes scanned for value leaks.
  for (const link of record.links) {
    if (link.trace_id.includes(CANARY_PREFIX)) hits.push(link.trace_id);
    if (link.span_id.includes(CANARY_PREFIX)) hits.push(link.span_id);
    hits.push(...leakedCanaries(link.attributes));
  }

  return hits;
}

/** Build a RawRecord seeded with unique canaries at every tokenizable position. */
function canaryRecord(): RawRecord {
  return {
    id: canary(),
    trace_id: canary(),
    parent_id: canary(),
    name: "safe-name",
    kind: "safe-kind",
    start: "2026-01-01T00:00:00.000Z",
    end: "2026-01-01T00:00:01.000Z",
    status: "error",
    error: { kind: "safe-error-kind", message: canary() },
    inputs: {
      prompt: canary(),
      nested: {
        level1: { level2: { level3: { level4: { level5: canary() } } } },
      },
      list: [canary(), canary(), { inner: canary() }],
    },
    outputs: {
      result: canary(),
      deep: { a: { b: { c: { d: { e: canary() } } } } },
      arr: [canary(), 42, true, null],
    },
    attributes: {
      "attr-top": canary(),
      "attr-nested": { child: canary() },
      "attr-array": [canary(), canary()],
    },
    labels: [
      { key: "safe-label-key", value: "safe-label-value", comment: canary() },
      { key: "other", value: 7, comment: canary() },
    ],
    links: [
      {
        trace_id: canary(),
        span_id: canary(),
        attributes: { "link-attr": canary() },
      },
    ],
    unmapped: {
      "unknown-field": canary(),
      "unknown-nested": { deeper: canary() },
    },
    source: { vendor: "generic-jsonl" },
  };
}

describe("canary leak suite", () => {
  test("generic JSONL — zero canaries in sanitized output", () => {
    const raw = canaryRecord();
    const corpus = sanitizeRecord(raw, SALT);

    const leaks = scanRecordForLeaks(corpus);
    expect(leaks).toEqual([]);
  });

  test("langsmith parser — zero canaries", () => {
    // Build a synthetic LangSmith export JSONL seeded with canaries at every tokenizable field.
    const cId = canary();
    const cTrace = canary();
    const cParent = canary();
    const cErr = canary();
    const cInput = canary();
    const cOutput = canary();
    const cMeta = canary();
    const cExtra = canary();
    const cFeedbackComment = canary();
    const cUnmapped = canary();

    const run = {
      id: cId,
      trace_id: cTrace,
      parent_run_id: cParent,
      name: "safe-name",
      run_type: "safe-run-type",
      start_time: "2026-01-01T00:00:00.000Z",
      end_time: "2026-01-01T00:00:01.000Z",
      status: "error",
      error: { kind: "safe-error-kind", message: cErr },
      inputs: { prompt: cInput, nested: { deep: { deeper: { deepest: cInput } } } },
      outputs: { result: cOutput, arr: [cOutput, cOutput] },
      session_id: cMeta,
      dob: cMeta,
      metadata: { region: cMeta },
      extra: { tags: [cExtra] },
      feedback: [{ key: "safe-key", value: 1, comment: cFeedbackComment }],
      custom_unknown_field: cUnmapped,
    };

    const dir = mkdtempSync(join(tmpdir(), "trace-grab-canary-langsmith-"));
    const file = join(dir, "run.jsonl");
    writeFileSync(file, JSON.stringify(run) + "\n");

    try {
      const records = readLangSmithExport(file);
      expect(records).toHaveLength(1);
      const corpus = sanitizeRecord(records[0]!, SALT);

      const leaks = scanRecordForLeaks(corpus);
      expect(leaks).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("otlp parser — zero canaries", () => {
    const cTrace = canary();
    const cSpan = canary();
    const cParent = canary();
    const cStatusMsg = canary();
    const cAttr = canary();
    const cNestedAttr = canary();
    const cArrayAttr = canary();
    const cLinkTrace = canary();
    const cLinkSpan = canary();
    const cLinkAttr = canary();
    const cResourceAttr = canary();
    const cScopeAttr = canary();
    const cUnmapped = canary();

    const otlp = {
      resourceSpans: [
        {
          resource: {
            attributes: [{ key: "service.name", value: { stringValue: cResourceAttr } }],
          },
          scopeSpans: [
            {
              scope: {
                name: "safe-scope",
                version: "1.0.0",
                attributes: [{ key: "scope.attr", value: { stringValue: cScopeAttr } }],
              },
              spans: [
                {
                  traceId: cTrace,
                  spanId: cSpan,
                  parentSpanId: cParent,
                  name: "safe-span-name",
                  kind: 1,
                  startTimeUnixNano: "1735689600000000000",
                  endTimeUnixNano: "1735689601000000000",
                  attributes: [
                    { key: "http.method", value: { stringValue: cAttr } },
                    {
                      key: "nested",
                      value: {
                        kvlistValue: {
                          values: [{ key: "inner", value: { stringValue: cNestedAttr } }],
                        },
                      },
                    },
                    {
                      key: "tags",
                      value: { arrayValue: { values: [{ stringValue: cArrayAttr }] } },
                    },
                  ],
                  links: [
                    {
                      traceId: cLinkTrace,
                      spanId: cLinkSpan,
                      attributes: [{ key: "link.attr", value: { stringValue: cLinkAttr } }],
                    },
                  ],
                  status: { code: 2, message: cStatusMsg },
                  unknownOtlpField: cUnmapped,
                },
              ],
            },
          ],
        },
      ],
    };

    const dir = mkdtempSync(join(tmpdir(), "trace-grab-canary-otlp-"));
    const file = join(dir, "export.json");
    writeFileSync(file, JSON.stringify(otlp));

    try {
      const records = readOtlpJson(file);
      expect(records).toHaveLength(1);
      const corpus = sanitizeRecord(records[0]!, SALT);

      const leaks = scanRecordForLeaks(corpus);
      expect(leaks).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("canaries in keys are intentionally present (ADR-0005)", () => {
    const canaryKey = canary();
    const raw: RawRecord = {
      id: "span-1",
      trace_id: "trace-1",
      parent_id: null,
      name: "safe-name",
      kind: "safe-kind",
      start: "2026-01-01T00:00:00.000Z",
      end: null,
      status: "unset",
      error: null,
      inputs: { [canaryKey]: "value-a" },
      outputs: { nested: { [canaryKey]: "value-b" } },
      attributes: { [canaryKey]: "value-c" },
      labels: [],
      links: [],
      unmapped: { [canaryKey]: "value-d" },
      source: { vendor: "generic-jsonl" },
    };

    const corpus = sanitizeRecord(raw, SALT);

    // Keys survive verbatim — assert the canary key is present in every bag.
    const inputKeys = survivingCanaryKeys(corpus.inputs);
    const outputKeys = survivingCanaryKeys(corpus.outputs);
    const attrKeys = survivingCanaryKeys(corpus.attributes);
    const unmappedKeys = survivingCanaryKeys(corpus.unmapped);

    expect(inputKeys).toContain(canaryKey);
    expect(outputKeys).toContain(canaryKey);
    expect(attrKeys).toContain(canaryKey);
    expect(unmappedKeys).toContain(canaryKey);
  });

  test("negative test: canary in pass-verbatim field DOES leak (suite can detect)", () => {
    // `name` and `kind` pass verbatim by design (ADR-0005). A canary placed there MUST survive,
    // proving the suite is not vacuously true — it can detect an unsanitized leak.
    const cName = canary();
    const cKind = canary();
    const cStart = canary();
    const cErrorKind = canary();
    const cLabelKey = canary();
    const cLabelValue = canary();
    const cVendor = canary();

    const raw: RawRecord = {
      id: "span-1",
      trace_id: "trace-1",
      parent_id: null,
      name: cName,
      kind: cKind,
      start: cStart,
      end: null,
      status: "ok",
      error: { kind: cErrorKind, message: "safe-message" },
      inputs: null,
      outputs: null,
      attributes: {},
      labels: [{ key: cLabelKey, value: cLabelValue, comment: null }],
      links: [],
      unmapped: {},
      source: { vendor: cVendor },
    };

    const corpus = sanitizeRecord(raw, SALT);

    // Every pass-verbatim canary survives — this is the intended behavior and the proof the
    // suite can detect a leak. If these assertions ever fail, the suite is vacuously green.
    expect(corpus.name).toBe(cName);
    expect(corpus.kind).toBe(cKind);
    expect(corpus.start).toBe(cStart);
    expect(corpus.error!.kind).toBe(cErrorKind);
    expect(corpus.labels[0]!.key).toBe(cLabelKey);
    expect(corpus.labels[0]!.value).toBe(cLabelValue);
    expect(corpus.source.vendor).toBe(cVendor);
  });
});