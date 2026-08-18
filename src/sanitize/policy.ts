import { existsSync, readFileSync } from "node:fs";

import { parse } from "yaml";

import { compareSpecificity, matchPath } from "./paths.js";

/**
 * The four dispositions per ADR-0009. `default` means "no rule matched — apply the built-in
 * SCHEMA.md behavior." See [POLICY.md](../../docs/POLICY.md) for the resolution truth table.
 */
export type Disposition = "reveal" | "tokenize" | "drop" | "default";

/** A parsed `tracegrab.yaml`. Absent file → `createDefaultPolicy()`. */
export interface Policy {
  version?: string;
  reveal: string[];
  tokenize: string[];
  drop: string[];
  time: "absolute" | "shift";
}

/** Thrown on any policy parse or validation failure. The CLI exits non-zero on this. */
export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

interface Rule {
  disposition: "reveal" | "tokenize" | "drop";
  pattern: string;
}

const VALID_KEYS = ["version", "reveal", "tokenize", "drop", "time"] as const;
const VALID_KEY_SET = new Set<string>(VALID_KEYS);

/**
 * Restrictiveness order for ADR-0009 tie-breaking. Lower = more restrictive.
 * `drop > tokenize > reveal`: drop removes the field entirely, tokenize destroys the value,
 * reveal passes it through.
 */
const RESTRICTIVENESS: Record<"drop" | "tokenize" | "reveal", number> = {
  drop: 0,
  tokenize: 1,
  reveal: 2,
};

/** The policy applied when no `tracegrab.yaml` exists — ADR-0005 deny-by-default. */
export function createDefaultPolicy(): Policy {
  return { reveal: [], tokenize: [], drop: [], time: "absolute" };
}

/** Parse and validate a `tracegrab.yaml` document. Throws `PolicyError` on any failure. */
export function parsePolicy(content: string): Policy {
  let parsed: unknown;
  try {
    parsed = parse(content);
  } catch (e) {
    throw new PolicyError(`Failed to parse tracegrab.yaml: ${(e as Error).message}`);
  }

  if (parsed === null || parsed === undefined) {
    return createDefaultPolicy();
  }

  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PolicyError(
      "tracegrab.yaml must be a YAML mapping (key: value pairs), not a scalar or list.",
    );
  }

  const obj = parsed as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!VALID_KEY_SET.has(key)) {
      throw new PolicyError(
        `Unknown key '${key}' in tracegrab.yaml. Valid keys: ${VALID_KEYS.join(", ")}.`,
      );
    }
  }

  const versionRaw = obj.version;
  if (versionRaw !== undefined && typeof versionRaw !== "string" && typeof versionRaw !== "number") {
    throw new PolicyError(`'version' must be a string or number, got ${typeof versionRaw}.`);
  }
  const version = typeof versionRaw === "number" ? String(versionRaw) : versionRaw;

  const reveal = extractPathArray(obj.reveal, "reveal");
  const tokenize = extractPathArray(obj.tokenize, "tokenize");
  const drop = extractPathArray(obj.drop, "drop");

  const timeRaw = obj.time;
  const time = timeRaw === undefined ? "absolute" : timeRaw;
  if (time !== "absolute" && time !== "shift") {
    throw new PolicyError(`'time' must be 'absolute' or 'shift', got '${time}'.`);
  }

  return { version, reveal, tokenize, drop, time };
}

function extractPathArray(value: unknown, name: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new PolicyError(`'${name}' must be a list of dotted paths, got ${typeof value}.`);
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) {
      throw new PolicyError(
        `'${name}' entries must be non-empty strings, got ${JSON.stringify(item)}.`,
      );
    }
    result.push(item);
  }
  return result;
}

/**
 * Load `tracegrab.yaml` from `path`. If `path` is undefined or the file does not exist,
 * returns the default policy — zero config is a valid, safe configuration (ADR-0005).
 */
export function loadPolicy(path?: string): Policy {
  if (path === undefined) return createDefaultPolicy();
  if (!existsSync(path)) return createDefaultPolicy();
  return parsePolicy(readFileSync(path, "utf8"));
}

/**
 * Resolves dispositions for paths in a corpus, applying ADR-0009 precedence.
 *
 * Resolution (see [POLICY.md](../../docs/POLICY.md)):
 * 1. Collect all rules whose pattern matches the path.
 * 2. If none, return `default`.
 * 3. The most specific rule wins (`compareSpecificity`).
 * 4. On a specificity tie, the more restrictive disposition wins: `drop > tokenize > reveal`.
 *
 * Also tracks which rule patterns matched at least one path, for unmatched-rule warnings (#9).
 */
export class PolicyResolver {
  private readonly rules: Rule[];
  private readonly matched: Set<string> = new Set();
  readonly time: "absolute" | "shift";

  constructor(policy: Policy = createDefaultPolicy()) {
    this.rules = [
      ...policy.reveal.map((pattern) => ({ disposition: "reveal" as const, pattern })),
      ...policy.tokenize.map((pattern) => ({ disposition: "tokenize" as const, pattern })),
      ...policy.drop.map((pattern) => ({ disposition: "drop" as const, pattern })),
    ];
    this.time = policy.time;
  }

  /** Resolve the disposition for a concrete dotted path. */
  decide(path: string): Disposition {
    const matching = this.rules.filter((r) => matchPath(r.pattern, path));
    if (matching.length === 0) return "default";

    for (const r of matching) this.matched.add(r.pattern);

    let best = matching[0];
    for (let i = 1; i < matching.length; i++) {
      if (compareSpecificity(matching[i].pattern, best.pattern) < 0) best = matching[i];
    }

    const tied = matching.filter((r) => compareSpecificity(r.pattern, best.pattern) === 0);
    if (tied.length === 1) return best.disposition;

    tied.sort((a, b) => RESTRICTIVENESS[a.disposition] - RESTRICTIVENESS[b.disposition]);
    return tied[0].disposition;
  }

  /** Warnings for rules that matched no path in the corpus (ADR-0009 unmatched-path warnings). */
  unmatchedWarnings(): string[] {
    return this.rules
      .filter((r) => !this.matched.has(r.pattern))
      .map(
        (r) =>
          `Policy rule '${r.disposition}: ${r.pattern}' matched no path in the corpus.`,
      );
  }
}
