import type { JsonValue } from "../normalize/record.js";

/**
 * Serializes a JSON value with object keys sorted alphabetically at every depth,
 * producing deterministic, compact (single-line) output regardless of key
 * insertion order. Single-line output is required for valid `corpus.jsonl`
 * (one record per line — JSON Lines).
 *
 * - Numbers, booleans, and null pass through to `JSON.stringify`.
 * - Strings pass through (escaped as normal JSON).
 * - Arrays preserve element order.
 * - Objects emit keys in ascending lexical order, recursively.
 *
 * Accepts `unknown` so concrete record interfaces (no index signature) serialize
 * without casts. This is the writer's determinism primitive (ADR-0010 / SCHEMA.md):
 * same input plus same salt must yield byte-identical `corpus.jsonl`.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, replacer);
}

/** Replacer that returns a new object with keys sorted at every object depth. */
function replacer(this: unknown, _key: string, value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = source[key];
    return sorted;
  }
  return value;
}
