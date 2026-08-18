import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

import type { CorpusRecord, JsonValue, RawRecord } from "../src/normalize/index.js";
import { sanitizeRecord } from "../src/sanitize/record.js";
import { tokenize } from "../src/sanitize/tokenize.js";

/**
 * Metamorphic property tests (ADR-0013). These encode the properties the RV thesis depends on,
 * exercised directly against the sanitizer in the repo that can break them:
 *
 *   a) Equality preservation — leaves equal before sanitization → equal tokens; unequal → unequal.
 *   b) Topology preservation — record count, parent/child structure, ordering, links unchanged.
 *   c) Determinism — same input + same salt → byte-identical corpus.jsonl (two separate processes).
 *   d) Idempotence — sanitizing a sanitized record preserves structure and equality relations.
 *   e) Salt sensitivity — different salts → disjoint token sets for the same input.
 *
 * Property-based over generated nested JSON. A small seeded PRNG (mulberry32) keeps every case
 * reproducible. Synthetic fixtures only.
 */

// ---------------------------------------------------------------------------
// Seeded PRNG — mulberry32. Deterministic from a 32-bit seed so a failure names
// the exact seed in its message and re-runs identically.
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;

function intIn(rng: Rng, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

function pick<T>(rng: Rng, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)] as T;
}

// ---------------------------------------------------------------------------
// Value pools — deliberately include the awkward cases: empty strings, emoji,
// CJK, astral-plane characters, control characters, and repeated values so the
// same string lands at different paths (the global value-scoping case).
// ---------------------------------------------------------------------------

const STRING_POOL: readonly string[] = [
  "",
  "",
  "hello",
  "hello",
  "world",
  "same-value",
  "same-value",
  "same-value",
  "different-value",
  "café",
  "日本語",
  "🎉",
  "🎉",
  "𝕏",
  "🚀",
  "a".repeat(64),
  "line\nbreak",
  "tab\there",
  "quote\"q",
  "back\\slash",
  "null\0byte",
  "mixed: abc123 — café 🎉 中",
  "mixed: abc123 — café 🎉 中",
  "x".repeat(200),
];

const KEY_POOL: readonly string[] = [
  "alpha",
  "beta",
  "gamma",
  "delta",
  "data",
  "meta",
  "nested",
  "items",
  "value",
  "extra",
  "café",
  "日本語",
  "🎉",
];

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Recursively build a nested JsonValue tree with controlled depth and width. */
function generateJson(depth: number, width: number, rng: Rng): JsonValue {
  if (depth <= 0 || rng() < 0.25) {
    const r = rng();
    if (r < 0.62) return pick(rng, STRING_POOL);
    if (r < 0.78) return intIn(rng, 0, 9999);
    if (r < 0.92) return rng() < 0.5;
    return null;
  }
  if (rng() < 0.5) {
    const len = intIn(rng, 1, width);
    const out: JsonValue[] = [];
    for (let i = 0; i < len; i++) out.push(generateJson(depth - 1, width, rng));
    return out;
  }
  const obj: { [key: string]: JsonValue } = {};
  const nkeys = intIn(rng, 1, width);
  for (let i = 0; i < nkeys; i++) obj[`${pick(rng, KEY_POOL)}_${i}`] = generateJson(depth - 1, width, rng);
  return obj;
}

/** A nested bag with at least one injected shared value across distinct paths. */
function generateBagWithShared(rng: Rng, shared: string): Record<string, JsonValue> {
  const bag = generateJson(intIn(rng, 3, 5), intIn(rng, 4, 10), rng);
  // Force the shared value at several different paths so equality across paths is exercised.
  const forced: Record<string, JsonValue> = {
    injected: shared,
    nested: { also: shared, deep: [shared, { again: shared } as JsonValue] as JsonValue },
    payload: bag,
  };
  return forced;
}

/** Build a full RawRecord with rich nested content and controlled cross-path collisions. */
function generateRecord(rng: Rng, id: string, traceId: string, parentId: string | null): RawRecord {
  const shared = pick(rng, STRING_POOL);
  const hasError = rng() < 0.5;
  return {
    id,
    trace_id: traceId,
    parent_id: parentId,
    name: pick(rng, ["run", "span", "tool", "chain"]),
    kind: pick(rng, ["llm", "chain", "tool", "retriever"]),
    start: "2024-01-01T00:00:00Z",
    end: rng() < 0.8 ? "2024-01-01T00:01:00Z" : null,
    status: pick(rng, ["unset", "ok", "error"] as const),
    error: hasError ? { kind: pick(rng, ["Timeout", "BadInput", "Internal"]), message: shared } : null,
    inputs: generateBagWithShared(rng, shared),
    outputs: generateBagWithShared(rng, shared),
    attributes: generateBagWithShared(rng, shared),
    labels: [
      { key: "env", value: pick(rng, ["prod", "dev"]), comment: rng() < 0.5 ? shared : null },
      { key: "team", value: intIn(rng, 1, 9), comment: pick(rng, STRING_POOL) },
    ],
    links:
      rng() < 0.7
        ? [
            {
              trace_id: shared,
              span_id: pick(rng, STRING_POOL),
              attributes: { ref: shared, meta: generateJson(2, 4, rng) },
            },
          ]
        : [],
    unmapped: generateBagWithShared(rng, shared),
    source: { vendor: "generic" },
  };
}

/** Build a trace: a root record plus a chain of children referencing prior ids (and a dangling one). */
function generateTrace(rng: Rng, traceId: string, spanCount: number): RawRecord[] {
  const records: RawRecord[] = [];
  const ids: string[] = [];
  for (let i = 0; i < spanCount; i++) {
    const id = `${traceId}-span-${i}`;
    ids.push(id);
    // First span is root; some children reference a real parent, one references a dangling id.
    let parentId: string | null;
    if (i === 0) parentId = null;
    else if (i === spanCount - 1) parentId = "dangling-parent-id";
    else parentId = pick(rng, ids.slice(0, i));
    records.push(generateRecord(rng, id, traceId, parentId));
  }
  return records;
}

// ---------------------------------------------------------------------------
// String-leaf / token-slot collectors
// ---------------------------------------------------------------------------

interface Slot {
  /** Dotted path that uniquely identifies a tokenized string position. */
  path: string;
  value: string;
}

/** Collect every string leaf (not keys) under an arbitrary JsonValue. */
function collectStringLeaves(value: JsonValue, prefix: string, out: Slot[]): void {
  if (typeof value === "string") {
    out.push({ path: prefix, value });
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) collectStringLeaves(value[i] as JsonValue, `${prefix}[${i}]`, out);
    return;
  }
  for (const [key, item] of Object.entries(value)) collectStringLeaves(item, `${prefix}.${key}`, out);
}

/** Collect every TOKENIZED string slot of a record (raw or corpus — same shape). */
function collectTokenizedSlots(rec: RawRecord | CorpusRecord): Slot[] {
  const slots: Slot[] = [];
  slots.push({ path: "id", value: rec.id });
  slots.push({ path: "trace_id", value: rec.trace_id });
  if (rec.parent_id !== null) slots.push({ path: "parent_id", value: rec.parent_id });
  if (rec.error !== null) slots.push({ path: "error.message", value: rec.error.message });
  collectStringLeaves(rec.inputs, "inputs", slots);
  collectStringLeaves(rec.outputs, "outputs", slots);
  collectStringLeaves(rec.attributes, "attributes", slots);
  collectStringLeaves(rec.unmapped, "unmapped", slots);
  for (let i = 0; i < rec.labels.length; i++) {
    const label = rec.labels[i];
    if (label.comment !== null) slots.push({ path: `labels[${i}].comment`, value: label.comment });
  }
  for (let i = 0; i < rec.links.length; i++) {
    const link = rec.links[i];
    slots.push({ path: `links[${i}].trace_id`, value: link.trace_id });
    slots.push({ path: `links[${i}].span_id`, value: link.span_id });
    collectStringLeaves(link.attributes, `links[${i}].attributes`, slots);
  }
  return slots;
}

/** Collect every token (`TOK_…`) appearing anywhere in a corpus record. */
function collectTokens(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    if (/^TOK_[0-9a-f]{10}$/.test(value)) out.add(value);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectTokens(item, out);
    return;
  }
  for (const item of Object.values(value as Record<string, unknown>)) collectTokens(item, out);
}

function collectRecordTokens(rec: CorpusRecord): Set<string> {
  const out = new Set<string>();
  collectTokens(rec, out);
  return out;
}

// ---------------------------------------------------------------------------
// Structural / shape comparison (ignores actual string values; used for idempotence)
// ---------------------------------------------------------------------------

function assertSameShape(a: unknown, b: unknown, path: string): void {
  const ta = a === null ? "null" : Array.isArray(a) ? "array" : typeof a;
  const tb = b === null ? "null" : Array.isArray(b) ? "array" : typeof b;
  if (ta !== tb) throw new Error(`shape mismatch at ${path}: ${ta} vs ${tb}`);
  if (a === null) return; // both null
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) throw new Error(`expected array at ${path}`);
    if (a.length !== b.length) throw new Error(`array length mismatch at ${path}: ${a.length} vs ${b.length}`);
    for (let i = 0; i < a.length; i++) assertSameShape(a[i], b[i], `${path}[${i}]`);
    return;
  }
  if (typeof a === "object") {
    const ak = Object.keys(a as Record<string, unknown>).sort();
    const bk = Object.keys(b as Record<string, unknown>).sort();
    if (ak.length !== bk.length || ak.some((k, i) => k !== bk[i])) {
      throw new Error(`key set mismatch at ${path}: [${ak.join(",")}] vs [${bk.join(",")}]`);
    }
    for (const k of ak) assertSameShape((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
    return;
  }
  // number / boolean: must be equal (these never change through sanitization)
  if (typeof a === "number" || typeof a === "boolean") {
    if (a !== b) throw new Error(`primitive mismatch at ${path}: ${String(a)} vs ${String(b)}`);
  }
  // strings: both must be strings (values may differ — tokenization); nothing else to check
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("metamorphic: equality preservation", () => {
  test("equal leaves → equal tokens; unequal leaves → unequal tokens (100+ cases)", () => {
    const salt = randomBytes(32);
    let failures = 0;
    const CASES = 150;
    for (let seed = 1; seed <= CASES; seed++) {
      const rng = mulberry32(seed);
      const rec = generateRecord(rng, `span-${seed}`, `trace-${seed}`, null);
      const rawSlots = collectTokenizedSlots(rec);
      const corpus = sanitizeRecord(rec, salt);
      const corpusSlots = collectTokenizedSlots(corpus);

      if (rawSlots.length !== corpusSlots.length) {
        failures++;
        continue;
      }
      // Build value maps keyed by path; paths align 1:1 because sanitization preserves structure.
      let ok = true;
      for (let i = 0; i < rawSlots.length && ok; i++) {
        for (let j = i + 1; j < rawSlots.length; j++) {
          if (rawSlots[i].path === corpusSlots[j].path) continue; // paranoia
          const eqBefore = rawSlots[i].value === rawSlots[j].value;
          const eqAfter = corpusSlots[i].value === corpusSlots[j].value;
          if (eqBefore !== eqAfter) {
            ok = false;
            break;
          }
        }
      }
      if (!ok) failures++;
    }
    expect(failures, `${failures}/${CASES} cases broke equality preservation`).toBe(0);
  });

  test("equality preservation covers deep nesting, wide arrays, unicode, empty strings", () => {
    const salt = randomBytes(32);
    // Construct an explicit adversarial record: the same string at many distinct paths,
    // alongside clearly-unequal unicode strings.
    const shared = "shared-marker-🎉-日本語";
    const rec: RawRecord = {
      id: shared,
      trace_id: shared,
      parent_id: shared,
      name: "span",
      kind: "run",
      start: "2024-01-01T00:00:00Z",
      end: null,
      status: "unset",
      error: { kind: "BadInput", message: shared },
      inputs: {
        empty: "",
        also_empty: "",
        nested: { deep: { deeper: [shared, shared, shared] as JsonValue } as JsonValue } as JsonValue,
        unicode: ["café", "café", "日本語", "🎉"] as JsonValue,
        wide: Array.from({ length: 12 }, (_, i) => `item-${i}`) as JsonValue,
      },
      outputs: { ref: shared, other: "different-value" },
      attributes: { k: shared, v: "" },
      labels: [{ key: "env", value: "prod", comment: shared }],
      links: [{ trace_id: shared, span_id: shared, attributes: { ref: shared } }],
      unmapped: { again: shared, deep: [{ x: shared } as JsonValue] as JsonValue },
      source: { vendor: "generic" },
    };
    const rawSlots = collectTokenizedSlots(rec);
    const corpus = sanitizeRecord(rec, salt);
    const corpusSlots = collectTokenizedSlots(corpus);

    expect(corpusSlots.length).toBe(rawSlots.length);
    for (let i = 0; i < rawSlots.length; i++) {
      for (let j = i + 1; j < rawSlots.length; j++) {
        const eqBefore = rawSlots[i].value === rawSlots[j].value;
        const eqAfter = corpusSlots[i].value === corpusSlots[j].value;
        if (eqBefore !== eqAfter) {
          throw new Error(
            `equality broken: ${rawSlots[i].path}=${JSON.stringify(rawSlots[i].value)} vs ` +
              `${rawSlots[j].path}=${JSON.stringify(rawSlots[j].value)} → ` +
              `${corpusSlots[i].path}=${corpusSlots[i].value} vs ${corpusSlots[j].path}=${corpusSlots[j].value}`,
          );
        }
      }
    }
    // Direct checks on the known-shared value: every occurrence is the same token.
    const sharedTokens = corpusSlots.filter((s, i) => rawSlots[i].value === shared).map((s) => s.value);
    expect(sharedTokens.length).toBeGreaterThan(8);
    expect(new Set(sharedTokens).size).toBe(1);
  });
});

describe("metamorphic: topology preservation", () => {
  test("record count, parent/child structure, ordering, and links preserved", () => {
    const salt = randomBytes(32);
    const rng = mulberry32(4242);
    const records: RawRecord[] = [];
    for (let t = 0; t < 5; t++) {
      records.push(...generateTrace(rng, `trace-${t}`, intIn(rng, 2, 4)));
    }
    const corpus = records.map((r) => sanitizeRecord(r, salt));

    // Count unchanged.
    expect(corpus.length).toBe(records.length);

    // Tokenized id map (raw id → token id) to verify parent/child links survive.
    const idToToken = new Map<string, string>();
    for (let i = 0; i < records.length; i++) {
      idToToken.set(records[i].id, corpus[i].id);
    }

    for (let i = 0; i < records.length; i++) {
      const raw = records[i];
      const cor = corpus[i];

      // Order preserved: array positions stable.
      expect(cor.id).toBe(idToToken.get(raw.id));

      // parent_id structure: null stays null; non-null tokenized.
      if (raw.parent_id === null) {
        expect(cor.parent_id).toBeNull();
      } else {
        expect(cor.parent_id).not.toBeNull();
        // If the parent exists in the set, the token must equal the parent's tokenized id
        // (global value-scoping: same string → same token, so the parent link is preserved).
        if (idToToken.has(raw.parent_id)) {
          expect(cor.parent_id).toBe(idToToken.get(raw.parent_id));
        } else {
          // Dangling parent: still tokenized to a stable value (equality with raw.parent_id).
          expect(cor.parent_id).toBe(tokenize(raw.parent_id, salt));
        }
      }

      // trace_id tokenized consistently: every record in the same trace shares the token.
      expect(cor.trace_id).toBe(tokenize(raw.trace_id, salt));

      // Ordering of labels and links preserved (same length, same pass-verbatim keys).
      expect(cor.labels.length).toBe(raw.labels.length);
      for (let l = 0; l < raw.labels.length; l++) {
        expect(cor.labels[l].key).toBe(raw.labels[l].key);
        expect(cor.labels[l].value).toBe(raw.labels[l].value);
      }
      expect(cor.links.length).toBe(raw.links.length);
      for (let l = 0; l < raw.links.length; l++) {
        expect(cor.links[l].trace_id).toBe(tokenize(raw.links[l].trace_id, salt));
        expect(cor.links[l].span_id).toBe(tokenize(raw.links[l].span_id, salt));
      }

      // Pass-verbatim scalars unchanged.
      expect(cor.name).toBe(raw.name);
      expect(cor.kind).toBe(raw.kind);
      expect(cor.status).toBe(raw.status);
      expect(cor.start).toBe(raw.start);
      expect(cor.end).toBe(raw.end);
      expect(cor.source.vendor).toBe(raw.source.vendor);

      // Error structure preserved; message tokenized; kind verbatim.
      if (raw.error === null) {
        expect(cor.error).toBeNull();
      } else {
        expect(cor.error).not.toBeNull();
        expect(cor.error!.kind).toBe(raw.error.kind);
        expect(cor.error!.message).toBe(tokenize(raw.error.message, salt));
      }
    }
  });
});

describe("metamorphic: determinism across separate processes", () => {
  test("same input + same salt → byte-identical corpus.jsonl; manifest differs only in generated_at", () => {
    const workDir = mkdtempSync(join(tmpdir(), "tg-metamor-determinism-"));
    try {
      const rng = mulberry32(7);
      const records: RawRecord[] = [];
      for (let t = 0; t < 3; t++) records.push(...generateTrace(rng, `trace-${t}`, 3));
      const fixturePath = join(workDir, "fixture.jsonl");
      writeFileSync(
        fixturePath,
        records.map((r) => JSON.stringify(r)).join("\n") + "\n",
        "utf8",
      );

      const cliPath = join(import.meta.dir, "..", "src", "cli.ts");
      const run = (outDir: string) => {
        const res = spawnSync(process.execPath, [cliPath, "grab", fixturePath, "--out", outDir], {
          cwd: workDir,
          encoding: "utf8",
        });
        if (res.status !== 0) {
          throw new Error(`grab failed (status ${res.status}): ${res.stderr}`);
        }
        if (!existsSync(join(outDir, "corpus.jsonl")) || !existsSync(join(outDir, "manifest.json"))) {
          throw new Error(`grab did not produce bundle in ${outDir}: ${res.stdout} ${res.stderr}`);
        }
      };

      const outA = join(workDir, "corpusA");
      const outB = join(workDir, "corpusB");
      run(outA);
      run(outB);

      // Byte-identical corpus.jsonl (same salt reused from .trace-grab/salt in workDir).
      const corpusA = readFileSync(join(outA, "corpus.jsonl"), "utf8");
      const corpusB = readFileSync(join(outB, "corpus.jsonl"), "utf8");
      expect(corpusA).toEqual(corpusB);

      // Manifest equal except generated_at.
      const manifestA = JSON.parse(readFileSync(join(outA, "manifest.json"), "utf8")) as Record<string, unknown>;
      const manifestB = JSON.parse(readFileSync(join(outB, "manifest.json"), "utf8")) as Record<string, unknown>;
      expect("generated_at" in manifestA).toBe(true);
      const ga = manifestA.generated_at;
      const gb = manifestB.generated_at;
      delete manifestA.generated_at;
      delete manifestB.generated_at;
      expect(manifestA).toEqual(manifestB);
      // generated_at should both be present (now extracted) — they may be equal if fast enough,
      // but the field must exist and be an ISO string either way.
      expect(typeof ga).toBe("string");
      expect(typeof gb).toBe("string");
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});

describe("metamorphic: idempotence", () => {
  test("sanitizing a sanitized record preserves structure, types, and equality relations", () => {
    const salt = randomBytes(32);
    const rng = mulberry32(99);
    const rec = generateRecord(rng, "span-idem", "trace-idem", "parent-idem");

    const once = sanitizeRecord(rec, salt);
    // CorpusRecord is structurally identical to RawRecord — feed it back through.
    const twice = sanitizeRecord(once as RawRecord, salt);

    // Structure, keys, array lengths, types, and non-string primitives unchanged.
    expect(() => assertSameShape(once, twice, "$")).not.toThrow();
    expect(() => assertSameShape(rec, once, "$")).not.toThrow();

    // Record count unchanged (single record here, but shape equivalence covers nesting/arrays).
    expect(Object.keys(twice).sort()).toEqual(Object.keys(once).sort());

    // Equality preservation holds through the second pass: equal tokens before → equal tokens after.
    const slotsOnce = collectTokenizedSlots(once);
    const slotsTwice = collectTokenizedSlots(twice);
    expect(slotsTwice.length).toBe(slotsOnce.length);
    for (let i = 0; i < slotsOnce.length; i++) {
      for (let j = i + 1; j < slotsOnce.length; j++) {
        const eqBefore = slotsOnce[i].value === slotsOnce[j].value;
        const eqAfter = slotsTwice[i].value === slotsTwice[j].value;
        if (eqBefore !== eqAfter) {
          throw new Error(
            `idempotent equality broken at ${slotsOnce[i].path} vs ${slotsOnce[j].path}`,
          );
        }
      }
    }

    // Double-tokenization changes token values (they are re-tokenized strings), but the token
    // shape is preserved — still TOK_<10hex>.
    const tokensOnce = collectRecordTokens(once);
    const tokensTwice = collectRecordTokens(twice);
    expect(tokensOnce.size).toBeGreaterThan(0);
    expect(tokensTwice.size).toBeGreaterThan(0);
    for (const tok of tokensOnce) expect(tok).toMatch(/^TOK_[0-9a-f]{10}$/);
    for (const tok of tokensTwice) expect(tok).toMatch(/^TOK_[0-9a-f]{10}$/);
    // Re-tokenizing a token must be deterministic: same token string → same re-token.
    const reMap = new Map<string, string>();
    for (let i = 0; i < slotsOnce.length; i++) {
      const prev = slotsOnce[i].value;
      const next = slotsTwice[i].value;
      if (reMap.has(prev)) expect(reMap.get(prev)).toBe(next);
      else reMap.set(prev, next);
    }
  });
});

describe("metamorphic: salt sensitivity", () => {
  test("different salts → disjoint token sets for the same input", () => {
    const rng = mulberry32(303);
    const rec = generateRecord(rng, "span-salt", "trace-salt", "parent-salt");
    const saltA = randomBytes(32);
    const saltB = randomBytes(32);
    // Ensure the two salts differ (randomBytes makes this astronomically likely; guard anyway).
    expect(saltA.equals(saltB)).toBe(false);

    const corpusA = sanitizeRecord(rec, saltA);
    const corpusB = sanitizeRecord(rec, saltB);

    const tokensA = collectRecordTokens(corpusA);
    const tokensB = collectRecordTokens(corpusB);

    expect(tokensA.size).toBeGreaterThan(4);
    expect(tokensB.size).toBeGreaterThan(4);
    const intersection = [...tokensA].filter((t) => tokensB.has(t));
    expect(intersection, `tokens shared across salts: ${intersection.join(", ")}`).toEqual([]);
  });
});
