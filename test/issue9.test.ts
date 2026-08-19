import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderReport, writeBundle, type Manifest } from "../src/bundle/index.js";
import type { InventoryEntry } from "../src/sanitize/inventory.js";

/** A valid manifest with safe defaults; spread `overrides` to mutate counts/warnings. */
function manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    schema_version: "trace-corpus-v1",
    generator: { name: "@emet/trace-grab", version: "0.1.0" },
    generated_at: "2026-08-18T23:55:37.481Z",
    source: { vendor: "langsmith" },
    counts: {
      traces: 3,
      records: 5,
      distinct_paths: 4,
      distinct_tokens: 12,
      dangling_parents: 0,
      excluded_traces: 0,
      excluded_by_limit: 0,
      excluded_by_window: 0,
    },
    policy_hash: "abc123def456",
    corpus_sha256: "deadbeefcafe",
    partner_label: null,
    warnings: [],
    ...overrides,
  };
}

/** An inventory entry with the fields that matter for a test, defaulting the rest. */
function entry(over: Partial<InventoryEntry> & Pick<InventoryEntry, "path" | "disposition">): InventoryEntry {
  return {
    occurrences: 1,
    distinctValues: 1,
    capped: false,
    example: null,
    ...over,
  };
}

const PASS_VERBATIM = [
  "name",
  "kind",
  "status",
  "error.kind",
  "start",
  "end",
  "labels[].key",
  "labels[].value",
  "source.vendor",
];

describe("issue #9: report renderer", () => {
  describe("AC #1 — zero-config plaintext section", () => {
    test("lists only the built-in pass-verbatim fields with a non-engineer sentence", () => {
      // Zero config: no reveals, only default/tokenize entries in the inventory.
      const inv: InventoryEntry[] = [
        entry({ path: "id", disposition: "default", example: "TOK_abc" }),
        entry({ path: "inputs.user_id", disposition: "default", example: "TOK_def" }),
        entry({ path: "name", disposition: "default", example: "probe" }),
      ];
      const report = renderReport(manifest(), inv);

      expect(report).toContain("## Plaintext fields");
      expect(report).toContain("Every string value");
      // Every built-in pass-verbatim field is listed.
      for (const field of PASS_VERBATIM) {
        expect(report).toContain(`- \`${field}\``);
      }
      // No reveal claim under zero config.
      expect(report).not.toContain("explicitly revealed");
    });
  });

  describe("AC #2 — unmatched policy rules render as a prominent warning", () => {
    test("unmatched rules appear under a Warnings heading, bolded, before the inventory table", () => {
      const m = manifest({
        warnings: ["Policy rule 'drop: inputs.ssn' matched no path in the corpus."],
      });
      const report = renderReport(m, []);

      expect(report).toContain("## Warnings");
      expect(report).toContain("**Unmatched policy rule**");
      expect(report).toContain("drop: inputs.ssn");
      // Prominent, not a footnote: the Warnings section precedes the inventory table.
      expect(report.indexOf("## Warnings")).toBeLessThan(report.indexOf("## Path inventory"));
    });

    test("dangling parents and excluded traces surface as warnings too", () => {
      const m = manifest({
        counts: {
          traces: 3,
          records: 5,
          distinct_paths: 4,
          distinct_tokens: 12,
          dangling_parents: 2,
          excluded_traces: 1,
          excluded_by_limit: 1,
          excluded_by_window: 0,
        },
      });
      const report = renderReport(m, []);
      expect(report).toContain("2 span(s) reference a parent_id absent from this corpus");
      expect(report).toContain("1 trace(s) were excluded");
    });
  });

  describe("AC #3 — empty inventory (zero-record corpus)", () => {
    test("renders without error, table present but empty, counts are zero", () => {
      const m = manifest({
        counts: {
          traces: 0,
          records: 0,
          distinct_paths: 0,
          distinct_tokens: 0,
          dangling_parents: 0,
          excluded_traces: 0,
          excluded_by_limit: 0,
          excluded_by_window: 0,
        },
      });
      const report = renderReport(m, []);

      expect(report).toContain("## Path inventory");
      expect(report).toContain("_No paths — zero-record corpus._");
      expect(report).toContain("- Records: 0");
      expect(report).toContain("- Traces: 0");
      // All six sections are present even on an empty corpus.
      for (const heading of [
        "## Plaintext fields",
        "## Warnings",
        "## Path inventory",
        "## Counts and integrity",
        "## Transfer",
        "## Keymap and salt",
      ]) {
        expect(report).toContain(heading);
      }
    });
  });

  describe("reveal rule surfaces in the plaintext section", () => {
    test("a revealed path is listed with its count and real example value", () => {
      const inv: InventoryEntry[] = [
        entry({
          path: "inputs.email",
          disposition: "reveal",
          occurrences: 4,
          distinctValues: 3,
          example: "ada@example.net",
        }),
        entry({ path: "id", disposition: "default", example: "TOK_abc" }),
      ];
      const report = renderReport(manifest(), inv);

      expect(report).toContain("These 1 field(s) were explicitly revealed");
      expect(report).toContain("`inputs.email` — 4 occurrence(s), example: `ada@example.net`");
    });
  });

  describe("capped inventory", () => {
    test("a capped path warns and the cap is noted in the table", () => {
      const inv: InventoryEntry[] = [
        entry({
          path: "attributes.score",
          disposition: "tokenize",
          occurrences: 5,
          distinctValues: 1000,
          capped: true,
          example: "TOK_abc123",
        }),
      ];
      const report = renderReport(manifest(), inv);

      // Warning surfaced.
      expect(report).toContain("Path `attributes.score` hit the distinct-value cap");
      // Table notes the cap with a `+` suffix on the distinct count.
      expect(report).toContain("| `attributes.score` | 5 | tokenize | 1000+ | `TOK_abc123` |");
      // Legend explains the `+`.
      expect(report).toContain("`+` means the path hit it");
    });
  });

  describe("section order", () => {
    test("all six sections appear in the spec order", () => {
      const report = renderReport(manifest(), []);
      const order = [
        "## Plaintext fields",
        "## Warnings",
        "## Path inventory",
        "## Counts and integrity",
        "## Transfer",
        "## Keymap and salt",
      ].map((h) => report.indexOf(h));
      for (let i = 1; i < order.length; i++) {
        expect(order[i]).toBeGreaterThan(order[i - 1]);
      }
    });
  });

  describe("integrity fields", () => {
    test("corpus SHA-256 and policy hash are present", () => {
      const report = renderReport(manifest(), []);
      expect(report).toContain("Corpus SHA-256: `deadbeefcafe`");
      expect(report).toContain("Policy hash: `abc123def456`");
    });

    test("keymap and salt are named and stated as excluded", () => {
      const report = renderReport(manifest(), []);
      expect(report).toContain("`.trace-grab/keymap.jsonl`");
      expect(report).toContain("`.trace-grab/salt`");
      expect(report).toContain("NOT included in this bundle");
    });

    test("transfer instructions include tar and curl templates", () => {
      const report = renderReport(manifest(), []);
      expect(report).toContain("tar -czf corpus.tar.gz");
      expect(report).toContain("curl -T corpus.tar.gz https://upload.example.net/PLACEHOLDER");
    });
  });

  describe("writeBundle round-trip", () => {
    const workDirs: string[] = [];
    afterEach(() => {
      while (workDirs.length > 0) {
        const dir = workDirs.pop()!;
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("report.md is written with all sections from the threaded inventory", async () => {
      const workDir = mkdtempSync(join(tmpdir(), "trace-grab-issue9-"));
      workDirs.push(workDir);
      const outDir = join(workDir, "corpus");

      const inv: InventoryEntry[] = [
        entry({
          path: "inputs.email",
          disposition: "reveal",
          occurrences: 4,
          distinctValues: 3,
          example: "ada@example.net",
        }),
      ];
      // Empty corpus (zero records) but a non-empty inventory snapshot — exercises the
      // threading of `BundleOptions.inventory` into report.md end to end.
      await writeBundle(outDir, [], 0, 0, { inventory: inv });

      const report = readFileSync(join(outDir, "report.md"), "utf8");
      expect(report).toContain("## Plaintext fields");
      expect(report).toContain("`inputs.email` — 4 occurrence(s), example: `ada@example.net`");
      expect(report).toContain("## Path inventory");
      expect(report).toContain("## Counts and integrity");
      expect(report).toContain("## Transfer");
      expect(report).toContain("## Keymap and salt");
    });
  });
});
