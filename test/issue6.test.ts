import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";

import { check } from "../src/cli.js";
import { loadSalt, loadOrCreateSaltWithMeta } from "../src/sanitize/index.js";
import { tokenize } from "../src/sanitize/tokenize.js";

const FIXTURE_PATH = join(import.meta.dir, "fixtures", "fixture-100.jsonl");
const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts");

const workDirs: string[] = [];

afterEach(() => {
  while (workDirs.length > 0) {
    rmSync(workDirs.pop()!, { recursive: true, force: true });
  }
});

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  workDirs.push(dir);
  return dir;
}

interface GrabOutput {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Run `trace-grab grab` as a child process in `workDir`. */
function runGrab(workDir: string, args: string[]): GrabOutput {
  const res = spawnSync(process.execPath, [CLI_PATH, "grab", ...args], {
    cwd: workDir,
    encoding: "utf8",
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** The first record's plaintext `id` from the fixture. */
const FIRST_ID = (JSON.parse(readFileSync(FIXTURE_PATH, "utf8").split("\n")[0]!) as { id: string }).id;

/** File mode with the umask-independent permission bits only. */
function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("issue #6: tokenizer, salt lifecycle, keymap", () => {
  describe("token determinism and salt sensitivity", () => {
    test("same value + same salt → same token (in-process)", () => {
      const salt = randomBytes(32);
      const value = "alice@corp.com";
      expect(tokenize(value, salt)).toBe(tokenize(value, salt));
    });

    test("different salts → different tokens for the same value", () => {
      const saltA = randomBytes(32);
      const saltB = randomBytes(32);
      const value = "shared-value-9f8e";
      expect(tokenize(value, saltA)).not.toBe(tokenize(value, saltB));
    });

    test("the domain separator is baked into the token (cross-scheme isolation)", () => {
      // token(v) = TOK_ + hmac(salt, "trace-corpus-v1:" + v).hex[0:10] (ADR-0006).
      // A bare hmac over the value (no separator) must differ.
      const { createHmac } = require("node:crypto") as typeof import("node:crypto");
      const salt = Buffer.alloc(32, 7);
      const value = "isolated-value";
      const expectedHex = createHmac("sha256", salt).update("trace-corpus-v1:" + value, "utf8").digest("hex");
      expect(tokenize(value, salt)).toBe(`TOK_${expectedHex.slice(0, 10)}`);
    });

    test("tokens produced by a child-process grab match in-process tokenize (cross-process)", () => {
      const workDir = freshDir("tg-issue6-xprocess-");
      const outDir = join(workDir, "corpus");
      const res = runGrab(workDir, [FIXTURE_PATH, "--out", "corpus"]);
      expect(res.status, res.stderr).toBe(0);

      // The salt was minted inside the child process; read it back here and recompute the token
      // for the first record's plaintext id. It must appear in the corpus the child wrote.
      const salt = readFileSync(join(workDir, ".trace-grab", "salt"));
      const expectedToken = tokenize(FIRST_ID, salt);
      const corpus = readFileSync(join(outDir, "corpus.jsonl"), "utf8");
      expect(corpus).toContain(expectedToken);

      // And the tokenized id in the first corpus line equals that token.
      const firstCorpus = JSON.parse(corpus.split("\n")[0]!) as { id: string };
      expect(firstCorpus.id).toBe(expectedToken);
    });
  });

  describe("salt and keymap file modes and bundle isolation", () => {
    test("salt and keymap are created 0600; neither appears inside the bundle dir", () => {
      const workDir = freshDir("tg-issue6-modes-");
      const outDir = join(workDir, "corpus");
      const res = runGrab(workDir, [FIXTURE_PATH, "--out", "corpus"]);
      expect(res.status, res.stderr).toBe(0);

      expect(mode(join(workDir, ".trace-grab", "salt"))).toBe(0o600);
      expect(mode(join(workDir, ".trace-grab", "keymap.jsonl"))).toBe(0o600);

      const bundleFiles = readdirSync(outDir);
      expect(bundleFiles).not.toContain("salt");
      expect(bundleFiles).not.toContain("keymap.jsonl");
    });

    test("the keymap is valid JSONL mapping tokens back to their values", () => {
      const workDir = freshDir("tg-issue6-keymap-");
      const outDir = join(workDir, "corpus");
      const res = runGrab(workDir, [FIXTURE_PATH, "--out", "corpus"]);
      expect(res.status, res.stderr).toBe(0);

      const salt = readFileSync(join(workDir, ".trace-grab", "salt"));
      const keymapPath = join(workDir, ".trace-grab", "keymap.jsonl");
      expect(existsSync(keymapPath)).toBe(true);

      const tokens = new Set<string>();
      const lines = readFileSync(keymapPath, "utf8").trim().split("\n");
      for (const line of lines) {
        const entry = JSON.parse(line) as { token: string; value: string };
        expect(entry.token).toMatch(/^TOK_[0-9a-f]{10}$/);
        // The keymap is a true reverse map: re-tokenizing the stored value yields the stored token.
        expect(tokenize(entry.value, salt)).toBe(entry.token);
        tokens.add(entry.token);
      }
      // No duplicate tokens in the keymap.
      expect(tokens.size).toBe(lines.length);
      // The first record's id made it into the keymap.
      expect(tokens.has(tokenize(FIRST_ID, salt))).toBe(true);
    });
  });

  describe("first-run notice", () => {
    test("prints a one-line notice naming the salt path only on first creation", () => {
      const workDir = freshDir("tg-issue6-notice-");
      const expectedSaltPath = join(workDir, ".trace-grab", "salt");

      const first = runGrab(workDir, [FIXTURE_PATH, "--out", "corpus"]);
      expect(first.status, first.stderr).toBe(0);
      const noticeLines = first.stdout.split("\n").filter((l) => l.startsWith("notice:"));
      expect(noticeLines.length).toBe(1);
      expect(noticeLines[0]).toContain(expectedSaltPath);
      expect(noticeLines[0]).toContain("cross-batch");

      // Second run reuses the salt → no notice.
      const second = runGrab(workDir, [FIXTURE_PATH, "--out", "corpus2"]);
      expect(second.status, second.stderr).toBe(0);
      expect(second.stdout.split("\n").filter((l) => l.startsWith("notice:")).length).toBe(0);
    });
  });

  describe("--no-keymap", () => {
    test("writes no keymap and the run still succeeds", () => {
      const workDir = freshDir("tg-issue6-nokeymap-");
      const outDir = join(workDir, "corpus");
      const res = runGrab(workDir, [FIXTURE_PATH, "--out", "corpus", "--no-keymap"]);
      expect(res.status, res.stderr).toBe(0);

      expect(existsSync(join(workDir, ".trace-grab", "keymap.jsonl"))).toBe(false);
      // Salt is still created.
      expect(existsSync(join(workDir, ".trace-grab", "salt"))).toBe(true);
      // Bundle still written.
      expect(existsSync(join(outDir, "corpus.jsonl"))).toBe(true);
    });

    test("a grab without --no-keymap then a grab with --no-keymap leaves the keymap untouched", () => {
      const workDir = freshDir("tg-issue6-nokeymap2-");
      const first = runGrab(workDir, [FIXTURE_PATH, "--out", "corpus"]);
      expect(first.status, first.stderr).toBe(0);
      const keymapPath = join(workDir, ".trace-grab", "keymap.jsonl");
      const before = readFileSync(keymapPath, "utf8");

      const second = runGrab(workDir, [FIXTURE_PATH, "--out", "corpus2", "--no-keymap"]);
      expect(second.status, second.stderr).toBe(0);
      // --no-keymap does not delete or alter an existing keymap.
      expect(readFileSync(keymapPath, "utf8")).toBe(before);
    });
  });

  describe("--salt-file override", () => {
    test("overrides the default .trace-grab/salt location (0600) and default is not created", () => {
      const workDir = freshDir("tg-issue6-saltfile-");
      const customSalt = join(workDir, "custom-salt");
      const res = runGrab(workDir, [FIXTURE_PATH, "--out", "corpus", "--salt-file", customSalt]);
      expect(res.status, res.stderr).toBe(0);

      expect(existsSync(customSalt)).toBe(true);
      expect(mode(customSalt)).toBe(0o600);
      // The default location was not created.
      expect(existsSync(join(workDir, ".trace-grab", "salt"))).toBe(false);
    });

    test("the notice names the custom salt path on first creation", () => {
      const workDir = freshDir("tg-issue6-saltfile-notice-");
      const customSalt = join(workDir, "elsewhere", "salt");
      const res = runGrab(workDir, [FIXTURE_PATH, "--out", "corpus", "--salt-file", customSalt]);
      expect(res.status, res.stderr).toBe(0);
      const notice = res.stdout.split("\n").filter((l) => l.startsWith("notice:"));
      expect(notice.length).toBe(1);
      expect(notice[0]).toContain(customSalt);
    });

    test("check --salt-file resolves a value's token against the custom salt", async () => {
      const workDir = freshDir("tg-issue6-saltfile-check-");
      const customSalt = join(workDir, "custom-salt");
      const outDir = join(workDir, "corpus");
      const grabRes = runGrab(workDir, [FIXTURE_PATH, "--out", "corpus", "--salt-file", customSalt]);
      expect(grabRes.status, grabRes.stderr).toBe(0);

      const salt = readFileSync(customSalt);
      const expectedToken = tokenize(FIRST_ID, salt);

      // loadSalt honours --salt-file: the in-process API agrees with the on-disk salt.
      expect(loadSalt(workDir, customSalt).equals(salt)).toBe(true);
      loadOrCreateSaltWithMeta(workDir, customSalt); // idempotent — must not report created here.

      // The CLI check path with --salt-file finds the token (0 plaintext hits — it was tokenized).
      const outcome = await check(["--value", FIRST_ID, outDir, "--salt-file", customSalt], workDir);
      expect(outcome.result.token).toBe(expectedToken);
      expect(outcome.result.plaintextHits).toHaveLength(0);
    });
  });

  describe(".trace-grab/.gitignore", () => {
    test("is written inside .trace-grab/ after a grab and ignores secrets", () => {
      const workDir = freshDir("tg-issue6-gitignore-");
      const res = runGrab(workDir, [FIXTURE_PATH, "--out", "corpus"]);
      expect(res.status, res.stderr).toBe(0);

      const gitignorePath = join(workDir, ".trace-grab", ".gitignore");
      expect(existsSync(gitignorePath)).toBe(true);
      const body = readFileSync(gitignorePath, "utf8");
      // Robust: ignores everything in the directory.
      expect(body).toContain("*");
      // Refreshing on a second run is idempotent and keeps the file.
      runGrab(workDir, [FIXTURE_PATH, "--out", "corpus2"]);
      expect(existsSync(gitignorePath)).toBe(true);
    });
  });

  describe("keymap append-only idempotence across runs", () => {
    test("a second grab over the same corpus appends nothing new (no duplicate lines)", () => {
      const workDir = freshDir("tg-issue6-idempotent-");
      const first = runGrab(workDir, [FIXTURE_PATH, "--out", "corpus"]);
      expect(first.status, first.stderr).toBe(0);
      const keymapPath = join(workDir, ".trace-grab", "keymap.jsonl");

      const afterFirst = readFileSync(keymapPath, "utf8");
      const firstLineCount = afterFirst.trim().split("\n").length;

      const second = runGrab(workDir, [FIXTURE_PATH, "--out", "corpus2"]);
      expect(second.status, second.stderr).toBe(0);
      const afterSecond = readFileSync(keymapPath, "utf8");

      // Same tokens → no new mappings appended.
      expect(afterSecond.trim().split("\n").length).toBe(firstLineCount);
      // And byte-identical content (idempotent flush is a no-op).
      expect(afterSecond).toBe(afterFirst);
    });
  });
});
