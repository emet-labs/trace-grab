import { readFileSync } from "node:fs";

import type { RawRecord } from "../normalize/index.js";

/**
 * Generic JSONL parser. One `RawRecord` per line, no validation depth — a hand-rolled export
 * already in the trace-corpus-v1 shape needs nothing more (SCHEMA.md's Scope section).
 */
export function readGenericJsonl(path: string): RawRecord[] {
  const text = readFileSync(path, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RawRecord);
}
