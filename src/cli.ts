#!/usr/bin/env node
import { statSync, readFileSync } from "node:fs";

import { writeBundle } from "./bundle/index.js";
import { limitTraces } from "./limit/index.js";
import type { RawRecord } from "./normalize/index.js";
import { loadOrCreateSalt, sanitizeRecord } from "./sanitize/index.js";
import { looksLikeOtlp, readGenericJsonl, readLangSmithExport, readOtlpJson } from "./sources/index.js";

const USAGE = `Usage: trace-grab <command> [options]

Commands:
  grab <input> --out <dir>   Read, normalize, sanitize, and write a bundle
    [--from langsmith|otlp|generic]
    [--since <iso>] [--until <iso>] [--max-traces <n>]
  check --value <v>          Locate a value's token in a bundle

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
  const since = parseFlag(args, "--since");
  const until = parseFlag(args, "--until");
  const maxTracesRaw = parseFlag(args, "--max-traces");

  let positional = dropFlag(args, "--from");
  positional = dropFlag(positional, "--since");
  positional = dropFlag(positional, "--until");
  positional = dropFlag(positional, "--max-traces");
  const [input] = positional;
  const out = parseFlag(positional, "--out");
  if (!input || !out) {
    console.error(
      "Usage: trace-grab grab <input> --out <dir> [--from langsmith|otlp|generic] [--since <iso>] [--until <iso>] [--max-traces <n>]",
    );
    process.exitCode = 1;
    return;
  }

  let maxTraces: number | undefined;
  if (maxTracesRaw !== undefined) {
    const n = Number.parseInt(maxTracesRaw, 10);
    if (Number.isNaN(n) || n < 0) {
      console.error(`error: --max-traces must be a non-negative integer, got '${maxTracesRaw}'`);
      process.exitCode = 1;
      return;
    }
    maxTraces = n;
  }
  if (since !== undefined && Number.isNaN(Date.parse(since))) {
    console.error(`error: --since is not a valid ISO-8601 timestamp: '${since}'`);
    process.exitCode = 1;
    return;
  }
  if (until !== undefined && Number.isNaN(Date.parse(until))) {
    console.error(`error: --until is not a valid ISO-8601 timestamp: '${until}'`);
    process.exitCode = 1;
    return;
  }

  const rawRecords = readInput(input, from);
  const { kept, excludedByWindow, excludedByLimit } = limitTraces(rawRecords, { since, until, maxTraces });
  const salt = loadOrCreateSalt();
  const corpusRecords = kept.map((record) => sanitizeRecord(record, salt));
  await writeBundle(out, corpusRecords, excludedByLimit, excludedByWindow);

  console.log(
    `Wrote ${corpusRecords.length} record(s) to ${out}` +
      ` (excluded ${excludedByWindow} trace(s) by window, ${excludedByLimit} by limit)`,
  );
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
      throw new Error(`'${command}' is not yet implemented`);
    default:
      console.log(USAGE);
      process.exitCode = command === undefined ? 0 : 1;
  }
}

main(process.argv.slice(2));
