import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";

import type { JsonValue, Label, RawRecord, SpanError, SpanStatus } from "../normalize/index.js";

/**
 * LangSmith export parser (ADR-0008). Reads a file or directory of LangSmith run exports
 * (JSON / JSONL) and maps each run to a `RawRecord`. Unknown top-level fields are preserved
 * verbatim in `unmapped` — never discarded (deny-by-default, SCHEMA.md).
 */

/** Top-level LangSmith run fields the mapper consumes directly. */
const KNOWN_FIELDS: Record<string, true> = {
  id: true,
  run_id: true,
  trace_id: true,
  parent_run_id: true,
  name: true,
  run_type: true,
  start_time: true,
  end_time: true,
  status: true,
  error: true,
  inputs: true,
  outputs: true,
  // Known metadata fields — merged into `attributes`.
  session_id: true,
  dob: true,
  metadata: true,
  extra: true,
  // Feedback / annotation arrays — mapped to `labels`.
  feedback: true,
  feedback_stats: true,
};

/** Known metadata fields copied verbatim into `attributes` under the same key. */
const ATTRIBUTE_FIELDS: Record<string, true> = {
  session_id: true,
  dob: true,
  metadata: true,
  extra: true,
};

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** LangSmith `status` → trace-corpus-v1 `SpanStatus`. Unrecognized values collapse to `unset`. */
function mapStatus(status: unknown): SpanStatus {
  if (typeof status !== "string") return "unset";
  switch (status) {
    case "success":
      return "ok";
    case "error":
    case "failed":
      return "error";
    default:
      return "unset";
  }
}

/**
 * LangSmith `error` → trace-corpus-v1 `SpanError`.
 * - string  → `{ kind: "error", message }`
 * - object  → `{ kind: error.kind || "error", message: error.message || "" }`
 * - absent  → `null`, unless `status` is `error` → `{ kind: "error", message: "" }`
 */
function mapError(error: unknown, status: SpanStatus): SpanError | null {
  if (typeof error === "string") {
    return { kind: "error", message: error };
  }
  if (isJsonObject(error)) {
    const kind = typeof error["kind"] === "string" ? (error["kind"] as string) : "error";
    const message = typeof error["message"] === "string" ? (error["message"] as string) : "";
    return { kind, message };
  }
  if (status === "error") {
    return { kind: "error", message: "" };
  }
  return null;
}

/** Feedback / annotation entries → `labels`. Each becomes `{ key, value, comment }`. */
function mapLabels(feedback: unknown): Label[] {
  if (!Array.isArray(feedback)) return [];
  const labels: Label[] = [];
  for (const entry of feedback) {
    if (!isJsonObject(entry)) continue;
    const key = asString(entry["key"]);
    const value: JsonValue = entry["value"] === undefined ? null : (entry["value"] as JsonValue);
    const comment =
      typeof entry["comment"] === "string" ? (entry["comment"] as string) : null;
    labels.push({ key, value, comment });
  }
  return labels;
}

/** Map a single parsed LangSmith run object to a `RawRecord`. Pure, no cross-record state. */
function mapRun(run: unknown): RawRecord {
  if (!isJsonObject(run)) {
    throw new Error(`LangSmith run is not a JSON object: ${JSON.stringify(run)}`);
  }

  const id = asString(run["id"] ?? run["run_id"]);
  const traceId = asString(run["trace_id"]);
  const parentId =
    typeof run["parent_run_id"] === "string" ? (run["parent_run_id"] as string) : null;
  const name = asString(run["name"]);
  const kind = asString(run["run_type"]);
  const start = asString(run["start_time"]);
  const end = typeof run["end_time"] === "string" ? (run["end_time"] as string) : null;
  const status = mapStatus(run["status"]);
  const error = mapError(run["error"], status);
  const inputs: JsonValue = run["inputs"] === undefined ? null : (run["inputs"] as JsonValue);
  const outputs: JsonValue =
    run["outputs"] === undefined ? null : (run["outputs"] as JsonValue);

  const attributes: Record<string, JsonValue> = {};
  for (const field of Object.keys(ATTRIBUTE_FIELDS)) {
    if (run[field] !== undefined) {
      attributes[field] = run[field] as JsonValue;
    }
  }

  const labels = [
    ...mapLabels(run["feedback"]),
    ...mapLabels(run["feedback_stats"]),
  ];

  const unmapped: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(run)) {
    if (!(key in KNOWN_FIELDS)) {
      unmapped[key] = value as JsonValue;
    }
  }

  return {
    id,
    trace_id: traceId,
    parent_id: parentId,
    name,
    kind,
    start,
    end,
    status,
    error,
    inputs,
    outputs,
    attributes,
    labels,
    links: [],
    unmapped,
    source: { vendor: "langsmith" },
  };
}

/**
 * Map native LangSmith run objects to the corpus input shape. Both file exports and the API
 * fetcher call this function so there is exactly one normalization path (ADR-0008).
 */
export function parseLangSmithRuns(runs: readonly unknown[]): RawRecord[] {
  return runs.map(mapRun);
}

/** Parse a `.jsonl` file: one run object per non-blank line. */
function readJsonlFile(path: string): unknown[] {
  const text = readFileSync(path, "utf8");
  const runs: unknown[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    runs.push(JSON.parse(line));
  }
  return runs;
}

/**
 * Parse a `.json` file. LangSmith bulk exports use `{ data: [...] }`; a bare array `[...]`
 * or a single run object are also accepted.
 */
function readJsonFile(path: string): unknown[] {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (Array.isArray(parsed)) return parsed;
  if (isJsonObject(parsed)) {
    if (Array.isArray(parsed["data"])) return parsed["data"] as unknown[];
    return [parsed];
  }
  throw new Error(`LangSmith JSON file ${path} is neither array, object, nor { data: [...] }`);
}

function readExportFile(path: string): unknown[] {
  const ext = extname(path).toLowerCase();
  if (ext === ".jsonl") return readJsonlFile(path);
  if (ext === ".json") return readJsonFile(path);
  throw new Error(`Unsupported LangSmith export extension: ${path}`);
}

/**
 * Read a LangSmith export — a single `.json`/`.jsonl` file or a directory of such files.
 * Directory entries are sorted alphabetically for deterministic output.
 */
export function readLangSmithExport(path: string): RawRecord[] {
  const stats = statSync(path);
  const files = stats.isDirectory()
    ? readdirSync(path)
        .filter((name) => {
          const ext = extname(name).toLowerCase();
          return ext === ".json" || ext === ".jsonl";
        })
        .sort()
        .map((name) => join(path, name))
    : [path];

  const runs: unknown[] = [];
  for (const file of files) {
    runs.push(...readExportFile(file));
  }
  return parseLangSmithRuns(runs);
}
