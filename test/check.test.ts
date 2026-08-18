import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkValue } from "../src/check/index.js";
import { check } from "../src/cli.js";
import type { CorpusRecord, JsonValue, RawRecord } from "../src/normalize/index.js";
import { loadOrCreateSalt, sanitizeRecord } from "../src/sanitize/index.js";
import { tokenize } from "../src/sanitize/tokenize.js";
import { readGenericJsonl } from "../src/sources/index.js";
import { writeBundle } from "../src/bundle/index.js";

const FIXTURE_PATH = join(import.meta.dir, "fixtures", "fixture-100.jsonl");

const workDirs: string[] = [];

afterEach(() => {
  while (workDirs.length > 0) {
    const dir = workDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

interface Scenario {
  workDir: string;
  outDir: string;
  salt: Buffer;
  rawRecords: RawRecord[];
  corpusRecords: CorpusRecord[];
}

/** Run the full grab pipeline on the fixture into a fresh temp work directory. */
async function setup(): Promise<Scenario> {
  const workDir = mkdtempSync(join(tmpdir(), "trace-grab-check-"));
  workDirs.push(workDir);
  const outDir = join(workDir, "corpus");

  const rawRecords = readGenericJsonl(FIXTURE_PATH);
  const salt = loadOrCreateSalt(workDir);
  const corpusRecords = rawRecords.map((record) => sanitizeRecord(record, salt));
  await writeBundle(outDir, corpusRecords);

  return { workDir, outDir, salt, rawRecords, corpusRecords };
}

const corpusPath = (s: Scenario): string => join(s.outDir, "corpus.jsonl");

/** Capture console.log and console.error lines emitted while running `fn`. */
async function captureLog<T>(fn: () => Promise<T>): Promise<{ lines: string[]; value: T }> {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const push = (...args: unknown[]): void => {
    lines.push(args.map(String).join(" "));
  };
  console.log = push;
  console.error = push;
  try {
    const value = await fn();
    return { lines, value };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

/** Recursive snapshot of a directory: relative path -> { size, mtimeMs }. */
function snapshotFiles(root: string): Record<string, { size: number; mtimeMs: number }> {
  const out: Record<string, { size: number; mtimeMs: number }> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const st = statSync(full);
        out[full.slice(root.length)] = { size: st.size, mtimeMs: st.mtimeMs };
      }
    }
  };
  walk(root);
  return out;
}

/** Returns relative paths of files under `root` whose contents contain `needle`. */
function filesContaining(root: string, needle: string): string[] {
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && readFileSync(full, "utf8").includes(needle)) {
        hits.push(full.slice(root.length));
      }
    }
  };
  walk(root);
  return hits;
}

describe("check --value", () => {
  test("a tokenized value is found as a token, never in plaintext (exit 0)", async () => {
    const s = await setup();
    // `user_id` is a tokenized string leaf; its raw value never survives in the corpus.
    const value = (s.rawRecords[0].inputs as Record<string, JsonValue>).user_id as string;
    const expectedToken = tokenize(value, s.salt);
    const expectedTokenHits = s.corpusRecords.filter((r) =>
      JSON.stringify(r).includes(expectedToken),
    ).length;

    const result = await checkValue(value, corpusPath(s), s.salt);
    const { lines, value: outcome } = await captureLog(() =>
      check(["--value", value, s.outDir], s.workDir),
    );

    expect(expectedTokenHits).toBeGreaterThan(0);
    expect(result.token).toBe(expectedToken);
    expect(result.tokenHits).toBe(expectedTokenHits);
    expect(result.plaintextHits).toHaveLength(0);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.result).toEqual(result);
    expect(lines.join("\n")).toContain(
      `appears as ${expectedToken} in ${expectedTokenHits} records; never appears in plaintext`,
    );
  });

  test("a pass-verbatim value is found in plaintext (exit non-zero)", async () => {
    const s = await setup();
    // `name` passes verbatim, so "op_0" survives as plaintext in every record it names.
    const value = "op_0";
    const expectedPlaintext = s.corpusRecords.filter((r) => r.name === value).length;

    const result = await checkValue(value, corpusPath(s), s.salt);
    const { lines, value: outcome } = await captureLog(() =>
      check(["--value", value, s.outDir], s.workDir),
    );

    expect(expectedPlaintext).toBeGreaterThan(0);
    expect(result.plaintextHits).toHaveLength(expectedPlaintext);
    // `name` is never tokenized, so the value's token appears in no record.
    expect(result.tokenHits).toBe(0);
    for (const hit of result.plaintextHits) {
      expect(hit.line).toBeGreaterThan(0);
      // Preview is the first 100 chars of the line — a context window, not the match span.
      expect(hit.preview.length).toBeLessThanOrEqual(100);
    }
    expect(outcome.exitCode).toBe(1);
    const report = lines.join("\n");
    expect(report).toContain(`PLAINTEXT FOUND in ${expectedPlaintext} records:`);
    expect(report).toMatch(/line \d+:/);
  });

  test("a value absent from the corpus reports zero occurrences of both forms", async () => {
    const s = await setup();
    const value = "definitely-not-in-the-corpus-xyz-9999";

    const result = await checkValue(value, corpusPath(s), s.salt);
    const outcome = await check(["--value", value, s.outDir], s.workDir);

    expect(result.token).toBe(tokenize(value, s.salt));
    expect(result.tokenHits).toBe(0);
    expect(result.plaintextHits).toHaveLength(0);
    expect(outcome.exitCode).toBe(0);
  });

  test("never writes the searched value to any file", async () => {
    const s = await setup();
    const sentinel = "SENTINEL_NEVER_PERSIST_a1b2c3d4e5";

    const before = snapshotFiles(s.workDir);
    const outcome = await check(["--value", sentinel, s.outDir], s.workDir);
    const after = snapshotFiles(s.workDir);

    expect(outcome.exitCode).toBe(0);
    // No new, removed, or modified files — `check` is read-only.
    expect(after).toEqual(before);
    // The searched value appears in no file under the work directory.
    expect(filesContaining(s.workDir, sentinel)).toEqual([]);
  });

  test("missing --value or bundle-dir exits non-zero with a usage message", async () => {
    const s = await setup();
    const { lines, value: outcome } = await captureLog(() =>
      check(["--value", "anything"], s.workDir),
    );
    expect(outcome.exitCode).toBe(1);
    expect(lines.join("\n")).toContain("Usage: trace-grab check");
  });
});
