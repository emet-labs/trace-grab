import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeBundle } from "../src/bundle/index.js";
import { stableStringify } from "../src/bundle/stable-stringify.js";
import type { CorpusRecord, JsonValue, RawRecord } from "../src/normalize/index.js";
import { PathInventory, loadOrCreateSalt, sanitizeRecord } from "../src/sanitize/index.js";
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

async function run(): Promise<{
  workDir: string;
  outDir: string;
  rawRecords: RawRecord[];
  corpusRecords: CorpusRecord[];
}> {
  const workDir = mkdtempSync(join(tmpdir(), "trace-grab-test-"));
  workDirs.push(workDir);
  const outDir = join(workDir, "corpus");

  const rawRecords = readGenericJsonl(FIXTURE_PATH);
  const salt = loadOrCreateSalt(workDir);
  const inventory = new PathInventory();
  const onInventory = inventory.callback();
  const corpusRecords = rawRecords.map((record) => sanitizeRecord(record, salt, undefined, undefined, onInventory));
  await writeBundle(outDir, corpusRecords, 0, 0, { inventory: inventory.entries() });

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
  test("record count in equals record count out", async () => {
    const { rawRecords, corpusRecords } = await run();
    expect(corpusRecords.length).toBe(rawRecords.length);
    expect(rawRecords.length).toBe(100);
  });

  test("zero plaintext string values outside pass-verbatim fields", async () => {
    const { corpusRecords } = await run();

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

  test("pass-verbatim fields are unchanged", async () => {
    const { rawRecords, corpusRecords } = await run();

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

  test("equal input values produce equal tokens across different records and different paths", async () => {
    const { rawRecords, corpusRecords } = await run();
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

  test("writes corpus.jsonl and a manifest.json describing the run", async () => {
    const { outDir, rawRecords } = await run();

    // Each record is exactly one JSONL line (single-line, sorted keys).
    const corpusText = readFileSync(join(outDir, "corpus.jsonl"), "utf8");
    const corpusLines = corpusText.trim().split("\n");
    expect(corpusLines.length).toBe(rawRecords.length);
    for (const line of corpusLines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }

    const manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"));
    expect(manifest.schema_version).toBe("trace-corpus-v1");
    expect(manifest.counts.records).toBe(rawRecords.length);
    expect(manifest.counts.dangling_parents).toBe(1);
    expect(manifest.warnings).toEqual([]);
    // corpus_sha256 is the streaming hash of the corpus bytes.
    expect(manifest.corpus_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("corpus.jsonl is byte-identical across two runs with the same salt", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "trace-grab-determinism-"));
    workDirs.push(workDir);
    const salt = loadOrCreateSalt(workDir);
    const rawRecords = readGenericJsonl(FIXTURE_PATH);
    const records = rawRecords.map((record) => sanitizeRecord(record, salt));

    const outA = join(workDir, "a", "corpus");
    const outB = join(workDir, "b", "corpus");
    await writeBundle(outA, records);
    await writeBundle(outB, records);

    const corpusA = readFileSync(join(outA, "corpus.jsonl"), "utf8");
    const corpusB = readFileSync(join(outB, "corpus.jsonl"), "utf8");
    expect(corpusA).toBe(corpusB);

    // manifest.json differs only in generated_at.
    const manifestA = JSON.parse(readFileSync(join(outA, "manifest.json"), "utf8"));
    const manifestB = JSON.parse(readFileSync(join(outB, "manifest.json"), "utf8"));
    const { generated_at: _a, ...restA } = manifestA;
    const { generated_at: _b, ...restB } = manifestB;
    expect(restA).toEqual(restB);

    // policy.yaml and report.md are deterministic too.
    expect(readFileSync(join(outA, "policy.yaml"), "utf8")).toBe(
      readFileSync(join(outB, "policy.yaml"), "utf8"),
    );
  });

  test("stableStringify sorts object keys at every depth regardless of insertion order", () => {
    const unsorted: JsonValue = {
      b: { d: 1, c: 2, a: 3 },
      a: [3, 1, 2],
      c: null,
    };
    const text = stableStringify(unsorted);
    // Compact, single-line output (valid JSONL — one record per line).
    expect(text).not.toContain("\n");
    const parsed = JSON.parse(text) as Record<string, JsonValue>;
    // Top-level keys ascending.
    expect(Object.keys(parsed)).toEqual(["a", "b", "c"]);
    // Nested object keys ascending.
    expect(Object.keys(parsed.b as Record<string, JsonValue>)).toEqual(["a", "c", "d"]);
    // Array order preserved.
    expect(parsed.a).toEqual([3, 1, 2]);
    // Round-trips to the same value.
    expect(JSON.parse(stableStringify(unsorted))).toEqual(unsorted);
  });

  test("writes policy.yaml and report.md alongside the bundle", async () => {
    const { outDir, rawRecords, corpusRecords } = await run();
    const traceCount = new Set(corpusRecords.map((r) => r.trace_id)).size;

    const policy = readFileSync(join(outDir, "policy.yaml"), "utf8");
    expect(policy).toContain("schema: trace-corpus-v1");
    expect(policy).toContain("strings: tokenize");
    expect(policy).toContain("numbers: pass");
    expect(policy).toContain("keys: pass");
    expect(policy).toContain("- name");
    expect(policy).toContain("- kind");
    expect(policy).toContain("- status");
    expect(policy).toContain("- error.kind");
    expect(policy).toContain("- labels[].key");
    expect(policy).toContain("- labels[].value");
    expect(policy).toContain("- source.vendor");
    expect(policy).toContain("reveals: []");
    expect(policy).toContain("drops: []");
    expect(policy).toContain("time: absolute");

    const report = readFileSync(join(outDir, "report.md"), "utf8");
    expect(report).toContain("# trace-grab corpus report");
    expect(report).toContain("Generated by @emet/trace-grab");
    expect(report).toContain("## Plaintext fields");
    expect(report).toContain("## Warnings");
    // Zero-config run: no reveals, so the plaintext section falls back to the pass-verbatim set.
    expect(report).toContain("Every string value");
    // The fixture's dangling parent surfaces as a prominent warning, not a buried count.
    expect(report).toContain("1 span(s) reference a parent_id absent from this corpus");
    expect(report).toContain(`- Traces: ${traceCount}`);
    expect(report).toContain(`- Records: ${rawRecords.length}`);
    // The e2e run threads a PathInventory through the bundle, so the inventory table is
    // populated (not the zero-record placeholder) — the real grab pipeline, not a stub.
    expect(report).toContain("## Path inventory");
    expect(report).not.toContain("_No paths — zero-record corpus._");
    // Tokenized string paths from the fixture surface in the table.
    expect(report).toContain("`inputs.user_id`");
  });
});
