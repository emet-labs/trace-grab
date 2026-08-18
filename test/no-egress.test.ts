import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * No-egress invariants (ADR-0007).
 *
 * These tests are a documentation artifact as much as a gate: they make the claim
 * "trace-grab has no Emet endpoint" checkable by running `bun test`, not by reading
 * every line of source. Each test scans `src/` at run time so it stays honest as the
 * tree grows — a violation introduced anywhere under `src/` fails CI.
 */

const SRC_DIR = join(import.meta.dir, "..", "src");

interface SourceFile {
  /** Path relative to `src/`, normalized to forward slashes. */
  readonly relPath: string;
  readonly content: string;
}

/** Every `.ts` file under `src/`, recursively. */
function listSourceFiles(): SourceFile[] {
  const entries = readdirSync(SRC_DIR, { recursive: true, encoding: "utf8" });
  const files: SourceFile[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".ts")) continue;
    const relPath = entry.split(/[\\/]/).join("/");
    const content = readFileSync(join(SRC_DIR, entry), "utf8");
    files.push({ relPath, content });
  }
  return files;
}

describe("no Emet-owned references outside package scope", () => {
  test("'emet' appears only as the scoped package name or the GitHub org", () => {
    const files = listSourceFiles();
    const violations: string[] = [];
    // The only legitimate occurrences of "emet" are the scoped package name
    // `@emet/trace-grab` and the GitHub org `emet-labs`. Strip those, then any
    // surviving "emet" is a stray domain/endpoint/identifier reference.
    const ALLOWED = /@emet\/trace-grab|emet-labs/gi;
    for (const { relPath, content } of files) {
      const remaining = content.replace(ALLOWED, "");
      const matches = remaining.match(/emet/gi);
      if (matches) {
        violations.push(`${relPath}: ${matches.length} stray 'emet' reference(s)`);
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });
});

describe("network primitives confined to the fetcher module", () => {
  test("fetch / node:http / node:https / node:net / WebSocket appear only in sources/langsmith-api.ts", () => {
    // The single network fetcher (ADR-0008). Until it lands, this allowlist is
    // empty in practice — every src/ file is scanned and any match is a violation.
    // When the fetcher is added, it lives here and only here.
    const NETWORK_ALLOWLIST = new Set(["sources/langsmith-api.ts"]);
    const PRIMITIVE = /fetch\s*\(|node:https|node:http|node:net|WebSocket/;
    const files = listSourceFiles();
    const violations: string[] = [];
    for (const { relPath, content } of files) {
      if (NETWORK_ALLOWLIST.has(relPath)) continue;
      const match = content.match(PRIMITIVE);
      if (match) {
        violations.push(`${relPath}: found network primitive '${match[0]}'`);
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });
});

describe("no Bun APIs in src/", () => {
  test("'Bun.' members and 'bun:' import schemes never appear in src/", () => {
    // ADR-0003: Bun for development, plain Node ≥20 for distribution. src/ must
    // build and run under stock Node, so Bun-specific APIs and the `bun:` import
    // scheme are forbidden there. (Tests may use them; src/ may not.)
    const BUN = /Bun\.|bun:/;
    const files = listSourceFiles();
    const violations: string[] = [];
    for (const { relPath, content } of files) {
      const match = content.match(BUN);
      if (match) {
        violations.push(`${relPath}: found Bun API '${match[0]}'`);
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });
});
