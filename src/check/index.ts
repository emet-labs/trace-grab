import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import { tokenize } from "../sanitize/tokenize.js";

export interface PlaintextHit {
  line: number;
  preview: string;
}

export interface CheckResult {
  token: string;
  tokenHits: number;
  plaintextHits: PlaintextHit[];
}

/**
 * Locates a value's token and any plaintext occurrences in a finished bundle (issue #14).
 *
 * Tokenizes `value` with the partner salt, then streams `corpus.jsonl` one line at a
 * time — never holding the whole corpus in memory. For each line (one record):
 * counts it as a token hit if it contains the token, and records a plaintext hit
 * (1-based line number + first 100 chars) if it contains the raw value as a substring.
 *
 * Read-only: writes nothing. The searched value never reaches disk.
 */
export async function checkValue(
  value: string,
  corpusPath: string,
  salt: Buffer,
): Promise<CheckResult> {
  const token = tokenize(value, salt);
  let tokenHits = 0;
  const plaintextHits: PlaintextHit[] = [];

  const input = createReadStream(corpusPath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });

  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber++;
    if (line.includes(value)) {
      plaintextHits.push({ line: lineNumber, preview: line.slice(0, 100) });
    }
    if (line.includes(token)) {
      tokenHits++;
    }
  }

  return { token, tokenHits, plaintextHits };
}
