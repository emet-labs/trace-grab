import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeBundle } from "../src/bundle/index.js";
import type { CorpusRecord, JsonValue, RawRecord } from "../src/normalize/index.js";
import { loadOrCreateSalt, sanitizeRecord } from "../src/sanitize/index.js";
import { readGenericJsonl } from "../src/sources/index.js";

const FIXTURE_PATH = join(import.meta.dir, "fixtures", "fixture-100.jsonl");

const TOKEN_PATTERN = /^TOK_[0-9a-f]{10}$/;

const workDirs: string[] = [];

afterEach(() => {
  while (workDirs.length > 0) {
    const dir = workDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function run() {
  const workDir = mkdtempSync(join(tmpdir(), "trace-grab-test-"));
  workDirs.push(workDir);
  const outDir = join(workDir, "corpus");

  const rawRecords = readGenericJsonl(FIXTURE_PATH);
  const salt = loadOrCreateSalt(workDir);
  const corpusRecords = rawRecords.map((record) => sanitizeRecord(record, salt));
  writeBundle(outDir, corpusRecords);

  return { workDir, outDir, rawRecords, corpusRecords };
}

/** Every string leaf under this JSON value is a token, no plaintext survives. */
function assertAllStringsTokenized(value: JsonValue, path: string): void {
  if (value === null || typeof value !== "object") {
    if (typeof value === "string") {
      expect(value, `${path} should be tokenized`).toMatch(TOKEN_PATTERN);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertAllStringsTokenized(item, `${path}[${i}]`));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    assertAllStringsTokenized(item, `${path}.${key}`);
  }
}

describe("grab end to end", () => {
  test("record count in equals record count out", () => {
    const { rawRecords, corpusRecords } = run();
    expect(corpusRecords.length).toBe(rawRecords.length);
    expect(rawRecords.length).toBe(100);
  });

  test("zero plaintext string values outside pass-verbatim fields", () => {
    const { corpusRecords } = run();

    for (const record of corpusRecords) {
      expect(record.id).toMatch(TOKEN_PATTERN);
      expect(record.trace_id).toMatch(TOKEN_PATTERN);
      if (record.parent_id !== null) expect(record.parent_id).toMatch(TOKEN_PATTERN);
      if (record.error !== null) expect(record.error.message).toMatch(TOKEN_PATTERN);

      assertAllStringsTokenized(record.inputs, "inputs");
      assertAllStringsTokenized(record.outputs, "outputs");
      assertAllStringsTokenized(record.attributes, "attributes");
      assertAllStringsTokenized(record.unmapped, "unmapped");

      for (const label of record.labels) {
        if (label.comment !== null) expect(label.comment).toMatch(TOKEN_PATTERN);
      }
      for (const link of record.links) {
        expect(link.trace_id).toMatch(TOKEN_PATTERN);
        expect(link.span_id).toMatch(TOKEN_PATTERN);
        assertAllStringsTokenized(link.attributes, "links[].attributes");
      }
    }
  });

  test("pass-verbatim fields are unchanged", () => {
    const { rawRecords, corpusRecords } = run();

    for (let i = 0; i < rawRecords.length; i++) {
      const raw = rawRecords[i] as RawRecord;
      const corpus = corpusRecords[i] as CorpusRecord;

      expect(corpus.name).toBe(raw.name);
      expect(corpus.kind).toBe(raw.kind);
      expect(corpus.status).toBe(raw.status);
      expect(corpus.start).toBe(raw.start);
      expect(corpus.end).toBe(raw.end);
      expect(corpus.source.vendor).toBe(raw.source.vendor);
      if (raw.error !== null) expect(corpus.error?.kind).toBe(raw.error.kind);

      expect(corpus.labels.map((l) => [l.key, l.value])).toEqual(raw.labels.map((l) => [l.key, l.value]));
    }
  });

  test("equal input values produce equal tokens across different records and different paths", () => {
    const { rawRecords, corpusRecords } = run();
    const valueToTokens = new Map<string, Set<string>>();

    function record(value: string, token: string): void {
      if (!valueToTokens.has(value)) valueToTokens.set(value, new Set());
      valueToTokens.get(value)?.add(token);
    }

    for (let i = 0; i < rawRecords.length; i++) {
      const raw = rawRecords[i] as RawRecord;
      const corpus = corpusRecords[i] as CorpusRecord;

      record(raw.id, corpus.id);
      record(raw.trace_id, corpus.trace_id);
      if (raw.parent_id !== null && corpus.parent_id !== null) record(raw.parent_id, corpus.parent_id);

      const rawInputs = raw.inputs as Record<string, JsonValue>;
      const corpusInputs = corpus.inputs as Record<string, JsonValue>;
      record(rawInputs.user_id as string, corpusInputs.user_id as string);
      record(rawInputs.session_token as string, corpusInputs.session_token as string);
    }

    for (const [value, tokens] of valueToTokens) {
      expect(tokens.size, `"${value}" should map to exactly one token`).toBe(1);
    }
    // trace_id repeats across every span in a trace — confirms this isn't vacuous.
    expect(valueToTokens.size).toBeLessThan(rawRecords.length * 4);
  });

  test("writes corpus.jsonl and a manifest.json describing the run", () => {
    const { outDir, rawRecords } = run();

    const corpusLines = readFileSync(join(outDir, "corpus.jsonl"), "utf8").trim().split("\n");
    expect(corpusLines.length).toBe(rawRecords.length);

    const manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"));
    expect(manifest.schema_version).toBe("trace-corpus-v1");
    expect(manifest.counts.records).toBe(rawRecords.length);
    expect(manifest.counts.dangling_parents).toBe(1);
    expect(manifest.warnings).toEqual([]);
  });
});
