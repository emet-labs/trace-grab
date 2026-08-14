import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { CorpusRecord } from "../normalize/index.js";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  name: string;
  version: string;
};

/** No policy file support yet (issue #3) — the manifest hashes this fixed built-in descriptor. */
const BUILTIN_POLICY_DESCRIPTOR = "trace-grab/builtin-defaults/v1";

const TOKEN_PATTERN = /^TOK_[0-9a-f]{10}$/;

export interface ManifestCounts {
  traces: number;
  records: number;
  distinct_paths: number;
  distinct_tokens: number;
  dangling_parents: number;
  excluded_traces: number;
}

export interface Manifest {
  schema_version: "trace-corpus-v1";
  generator: { name: string; version: string };
  generated_at: string;
  source: { vendor: string };
  counts: ManifestCounts;
  policy_hash: string;
  corpus_sha256: string;
  partner_label: string | null;
  warnings: string[];
}

/** Dotted object-key paths under `inputs`/`outputs`/`attributes`/`unmapped` — the report's query language (SCHEMA.md). */
function collectPaths(value: unknown, prefix: string, paths: Set<string>): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, prefix, paths);
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const path = `${prefix}.${key}`;
    paths.add(path);
    collectPaths(item, path, paths);
  }
}

function collectTokens(value: unknown, tokens: Set<string>): void {
  if (typeof value === "string") {
    if (TOKEN_PATTERN.test(value)) tokens.add(value);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectTokens(item, tokens);
    return;
  }
  for (const item of Object.values(value as Record<string, unknown>)) collectTokens(item, tokens);
}

export function buildManifest(records: CorpusRecord[], corpusBytes: Buffer): Manifest {
  const idTokens = new Set(records.map((record) => record.id));
  const paths = new Set<string>();
  const tokens = new Set<string>();
  let danglingParents = 0;

  for (const record of records) {
    for (const field of ["inputs", "outputs", "attributes", "unmapped"] as const) {
      collectPaths(record[field], field, paths);
    }
    collectTokens(record, tokens);
    if (record.parent_id !== null && !idTokens.has(record.parent_id)) {
      danglingParents += 1;
    }
  }

  return {
    schema_version: "trace-corpus-v1",
    generator: { name: pkg.name, version: pkg.version },
    generated_at: new Date().toISOString(),
    source: { vendor: records[0]?.source.vendor ?? "generic" },
    counts: {
      traces: new Set(records.map((record) => record.trace_id)).size,
      records: records.length,
      distinct_paths: paths.size,
      distinct_tokens: tokens.size,
      dangling_parents: danglingParents,
      excluded_traces: 0,
    },
    policy_hash: createHash("sha256").update(BUILTIN_POLICY_DESCRIPTOR).digest("hex"),
    corpus_sha256: createHash("sha256").update(corpusBytes).digest("hex"),
    partner_label: null,
    warnings: [],
  };
}
