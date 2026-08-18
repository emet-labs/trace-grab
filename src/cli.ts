#!/usr/bin/env node
import { statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { checkValue, type CheckResult } from "./check/index.js";
import { writeBundle } from "./bundle/index.js";
import type { RawRecord } from "./normalize/index.js";
import { loadOrCreateSalt, loadSalt, sanitizeRecord } from "./sanitize/index.js";
import { looksLikeOtlp, readGenericJsonl, readLangSmithExport, readOtlpJson } from "./sources/index.js";

const USAGE = `Usage: trace-grab <command> [options]

Commands:
  grab <input> --out <dir>   Read, normalize, sanitize, and write a bundle
  check --value <v> <bundle-dir>  Locate a value's token and any plaintext hits

Run 'trace-grab <command> --help' for command-specific options.`;

function parseFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

/** Strip a `--flag value` pair from args, returning the remaining positional/flag args. */
function dropFlag(args: string[], flag: string): string[] {
  const index = args.indexOf(flag);
  if (index === -1) return args;
  return args.slice(0, index).concat(args.slice(index + 2));
}

/**
 * Sniff an input file for LangSmith shape: a non-blank first line whose parsed object carries
 * `run_type` or `parent_run_id`. Only applies to single JSONL/JSON files — directories require
 * an explicit `--from langsmith`.
 */
function looksLikeLangSmith(path: string): boolean {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return false;
  }
  if (stats.isDirectory()) return false;
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        return "run_type" in record || "parent_run_id" in record;
      }
    } catch {
      return false;
    }
    break;
  }
  return false;
}

function readInput(input: string, from: string | undefined): RawRecord[] {
  const source = from ?? sniffSource(input);
  if (source === "langsmith") return readLangSmithExport(input);
  if (source === "otlp") return readOtlpJson(input);
  return readGenericJsonl(input);
}

/** Auto-detect the source format from file content, defaulting to generic JSONL. */
function sniffSource(path: string): string {
  if (looksLikeOtlp(path)) return "otlp";
  if (looksLikeLangSmith(path)) return "langsmith";
  return "generic";
}

async function grab(args: string[]): Promise<void> {
  const from = parseFlag(args, "--from");
  const positional = dropFlag(args, "--from");
  const [input] = positional;
  const out = parseFlag(positional, "--out");
  if (!input || !out) {
    console.error("Usage: trace-grab grab <input> --out <dir> [--from langsmith|otlp|generic]");
    process.exitCode = 1;
    return;
  }

  const rawRecords = readInput(input, from);
  const salt = loadOrCreateSalt();
  const corpusRecords = rawRecords.map((record) => sanitizeRecord(record, salt));
  await writeBundle(out, corpusRecords);

  console.log(`Wrote ${corpusRecords.length} record(s) to ${out}`);
}

/**
 * `check --value <v> <bundle-dir>`: locates a value's token and any plaintext leaks in a
 * finished bundle (issue #14). Tokenizes the value with the partner salt, streams
 * `corpus.jsonl`, and reports token hits and plaintext hits. Exits non-zero when the
 * value survives in plaintext so a partner can gate CI on it. Read-only — the searched
 * value is never written to disk.
 */
export async function check(
  args: string[],
  cwd: string = process.cwd(),
): Promise<{ exitCode: number; result: CheckResult }> {
  const value = parseFlag(args, "--value");
  const positional = dropFlag(args, "--value");
  const [bundleDir] = positional;

  if (!value || !bundleDir) {
    console.error("Usage: trace-grab check --value <v> <bundle-dir>");
    return { exitCode: 1, result: { token: "", tokenHits: 0, plaintextHits: [] } };
  }

  const salt = loadSalt(cwd);
  const result = await checkValue(value, join(bundleDir, "corpus.jsonl"), salt);

  if (result.plaintextHits.length === 0) {
    console.log(`appears as ${result.token} in ${result.tokenHits} records; never appears in plaintext`);
  } else {
    console.log(`PLAINTEXT FOUND in ${result.plaintextHits.length} records:`);
    for (const hit of result.plaintextHits) {
      console.log(`  line ${hit.line}: ${hit.preview}`);
    }
  }

  return { exitCode: result.plaintextHits.length > 0 ? 1 : 0, result };
}

function main(argv: string[]): void {
  const [command, ...rest] = argv;

  switch (command) {
    case "grab":
      void grab(rest).catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
      return;
    case "check":
      void check(rest)
        .then((outcome) => {
          if (outcome.exitCode !== 0) process.exitCode = outcome.exitCode;
        })
        .catch((error) => {
          console.error(error);
          process.exitCode = 1;
        });
      return;
    default:
      console.log(USAGE);
      process.exitCode = command === undefined ? 0 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
