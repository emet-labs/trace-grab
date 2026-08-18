import { describe, expect, test } from "bun:test";

import {
  PolicyError,
  PolicyResolver,
  createDefaultPolicy,
  loadPolicy,
  parsePolicy,
} from "../src/sanitize/policy.js";
import { sanitizeRecord } from "../src/sanitize/record.js";
import type { RawRecord } from "../src/normalize/index.js";

const TOKEN_PATTERN = /^TOK_[0-9a-f]{10}$/;

/** A minimal raw record for exercising the sanitizer's policy paths. */
function sampleRecord(): RawRecord {
  return {
    id: "rec-1",
    trace_id: "trace-1",
    parent_id: null,
    name: "SearchTool",
    kind: "tool",
    start: "2026-08-01T10:00:00.000Z",
    end: "2026-08-01T10:00:05.000Z",
    status: "ok",
    error: null,
    inputs: { user_id: "u_123", email: "alice@corp.com", items: [{ sku: "abc" }] },
    outputs: { result: "success", count: 3 },
    attributes: { env: "production" },
    labels: [{ key: "correctness", value: "correct", comment: "on point" }],
    links: [],
    unmapped: { note: "remember to fix" },
    source: { vendor: "langsmith" },
  };
}

// ---------------------------------------------------------------------------
// parsePolicy — the one file a security reviewer will actually read.
// Its failure modes must all be loud (ADR-0009).
// ---------------------------------------------------------------------------

describe("parsePolicy", () => {
  test("empty document → default policy (zero-config path)", () => {
    expect(parsePolicy("")).toEqual(createDefaultPolicy());
    expect(parsePolicy("---")).toEqual(createDefaultPolicy());
  });

  test("full valid policy", () => {
    const yaml = [
      "version: 1",
      "reveal:",
      "  - outputs.status",
      "tokenize:",
      "  - inputs.user.secret",
      "drop:",
      "  - inputs.ssn",
      "time: shift",
    ].join("\n");
    const p = parsePolicy(yaml);
    expect(p.version).toBe("1");
    expect(p.reveal).toEqual(["outputs.status"]);
    expect(p.tokenize).toEqual(["inputs.user.secret"]);
    expect(p.drop).toEqual(["inputs.ssn"]);
    expect(p.time).toBe("shift");
  });

  test("omitted lists default to empty arrays", () => {
    const p = parsePolicy("time: absolute");
    expect(p.reveal).toEqual([]);
    expect(p.tokenize).toEqual([]);
    expect(p.drop).toEqual([]);
  });

  test("omitted time defaults to absolute", () => {
    expect(parsePolicy("reveal: []").time).toBe("absolute");
  });
});

// ---------------------------------------------------------------------------
// Unknown top-level keys are a hard error (ADR-0009).
// ---------------------------------------------------------------------------

describe("parsePolicy — unknown keys", () => {
  test("typo'd top-level key exits non-zero (throws)", () => {
    expect(() => parsePolicy("revael: outputs.status")).toThrow(PolicyError);
    expect(() => parsePolicy("revael: outputs.status")).toThrow(/Unknown key 'revael'/);
  });

  test("error message names the offending key and lists valid keys", () => {
    try {
      parsePolicy("dropp: inputs.ssn");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PolicyError);
      const msg = (e as Error).message;
      expect(msg).toContain("'dropp'");
      expect(msg).toContain("version");
      expect(msg).toContain("reveal");
      expect(msg).toContain("tokenize");
      expect(msg).toContain("drop");
      expect(msg).toContain("time");
    }
  });

  test("multiple unknown keys — first one is reported", () => {
    expect(() => parsePolicy("foo: 1\nbar: 2")).toThrow(/Unknown key 'foo'/);
  });
});

// ---------------------------------------------------------------------------
// Type validation — wrong types on known keys.
// ---------------------------------------------------------------------------

describe("parsePolicy — type validation", () => {
  test("numeric version is accepted and stringified", () => {
    const p = parsePolicy("version: 1");
    expect(p.version).toBe("1");
  });

  test("boolean version is rejected", () => {
    expect(() => parsePolicy("version: true")).toThrow(PolicyError);
  });

  test("reveal not a list", () => {
    expect(() => parsePolicy("reveal: outputs.status")).toThrow(PolicyError);
  });

  test("drop entry not a string", () => {
    expect(() => parsePolicy("drop:\n  - 42")).toThrow(PolicyError);
  });

  test("empty string path", () => {
    expect(() => parsePolicy("drop:\n  - \"\"")).toThrow(PolicyError);
  });

  test("invalid time value", () => {
    expect(() => parsePolicy("time: tomorrow")).toThrow(PolicyError);
  });

  test("root must be a mapping, not a list", () => {
    expect(() => parsePolicy("- reveal")).toThrow(PolicyError);
  });

  test("root must be a mapping, not a scalar", () => {
    expect(() => parsePolicy("hello")).toThrow(PolicyError);
  });
});

// ---------------------------------------------------------------------------
// loadPolicy — file I/O
// ---------------------------------------------------------------------------

describe("loadPolicy", () => {
  test("undefined path → default policy", () => {
    expect(loadPolicy(undefined)).toEqual(createDefaultPolicy());
  });

  test("non-existent path → default policy (zero config)", () => {
    expect(loadPolicy("/nonexistent/tracegrab.yaml")).toEqual(createDefaultPolicy());
  });
});

// ---------------------------------------------------------------------------
// PolicyResolver.decide — the resolution truth table (POLICY.md).
// ---------------------------------------------------------------------------

describe("PolicyResolver.decide — no rules", () => {
  test("default policy: every path returns 'default'", () => {
    const r = new PolicyResolver();
    expect(r.decide("inputs.user.email")).toBe("default");
    expect(r.decide("name")).toBe("default");
    expect(r.decide("inputs.ssn")).toBe("default");
    expect(r.decide("outputs.status")).toBe("default");
  });
});

describe("PolicyResolver.decide — single rule", () => {
  test("exact match reveals", () => {
    const r = new PolicyResolver({ ...createDefaultPolicy(), reveal: ["inputs.user.email"] });
    expect(r.decide("inputs.user.email")).toBe("reveal");
    expect(r.decide("inputs.user.name")).toBe("default");
  });

  test("wildcard match drops", () => {
    const r = new PolicyResolver({ ...createDefaultPolicy(), drop: ["inputs.**"] });
    expect(r.decide("inputs.user.email")).toBe("drop");
    expect(r.decide("inputs")).toBe("drop");
    expect(r.decide("outputs.result")).toBe("default");
  });
});

// ---------------------------------------------------------------------------
// Cross-specificity: most-specific wins (POLICY.md truth table).
// ---------------------------------------------------------------------------

describe("PolicyResolver.decide — most-specific wins", () => {
  test("reveal beats broader drop (more specific)", () => {
    // drop: inputs.** (1 literal) vs reveal: inputs.user.email (3 literals)
    const r = new PolicyResolver({
      ...createDefaultPolicy(),
      drop: ["inputs.**"],
      reveal: ["inputs.user.email"],
    });
    expect(r.decide("inputs.user.email")).toBe("reveal");
  });

  test("drop beats broader reveal (more specific)", () => {
    // reveal: inputs.** (1 literal) vs drop: inputs.user.email (3 literals)
    const r = new PolicyResolver({
      ...createDefaultPolicy(),
      reveal: ["inputs.**"],
      drop: ["inputs.user.email"],
    });
    expect(r.decide("inputs.user.email")).toBe("drop");
  });

  test("tokenize narrows a broad reveal (more specific)", () => {
    // reveal: inputs.** vs tokenize: inputs.user.secret
    const r = new PolicyResolver({
      ...createDefaultPolicy(),
      reveal: ["inputs.**"],
      tokenize: ["inputs.user.secret"],
    });
    expect(r.decide("inputs.user.secret")).toBe("tokenize");
    expect(r.decide("inputs.user.email")).toBe("reveal");
  });

  test("drop narrows a broad reveal (more specific)", () => {
    const r = new PolicyResolver({
      ...createDefaultPolicy(),
      reveal: ["inputs.**"],
      drop: ["inputs.user.secret"],
    });
    expect(r.decide("inputs.user.secret")).toBe("drop");
    expect(r.decide("inputs.user.email")).toBe("reveal");
  });

  test("tokenize narrows a broad drop (more specific)", () => {
    const r = new PolicyResolver({
      ...createDefaultPolicy(),
      drop: ["inputs.**"],
      tokenize: ["inputs.user.email"],
    });
    expect(r.decide("inputs.user.email")).toBe("tokenize");
  });

  test("reveal narrows a broad tokenize (more specific)", () => {
    const r = new PolicyResolver({
      ...createDefaultPolicy(),
      tokenize: ["inputs.**"],
      reveal: ["inputs.user.email"],
    });
    expect(r.decide("inputs.user.email")).toBe("reveal");
  });
});

// ---------------------------------------------------------------------------
// Equal specificity: tie-break by restrictiveness (drop > tokenize > reveal).
// ---------------------------------------------------------------------------

describe("PolicyResolver.decide — equal specificity tie-break", () => {
  test("drop vs reveal (same pattern) → drop", () => {
    const r = new PolicyResolver({
      ...createDefaultPolicy(),
      drop: ["inputs.user.email"],
      reveal: ["inputs.user.email"],
    });
    expect(r.decide("inputs.user.email")).toBe("drop");
  });

  test("drop vs tokenize (same pattern) → drop", () => {
    const r = new PolicyResolver({
      ...createDefaultPolicy(),
      drop: ["inputs.user.email"],
      tokenize: ["inputs.user.email"],
    });
    expect(r.decide("inputs.user.email")).toBe("drop");
  });

  test("tokenize vs reveal (same pattern) → tokenize", () => {
    const r = new PolicyResolver({
      ...createDefaultPolicy(),
      tokenize: ["inputs.user.email"],
      reveal: ["inputs.user.email"],
    });
    expect(r.decide("inputs.user.email")).toBe("tokenize");
  });

  test("drop vs tokenize vs reveal (all same pattern) → drop", () => {
    const r = new PolicyResolver({
      ...createDefaultPolicy(),
      drop: ["inputs.user.email"],
      tokenize: ["inputs.user.email"],
      reveal: ["inputs.user.email"],
    });
    expect(r.decide("inputs.user.email")).toBe("drop");
  });

  test("equal-specificity via wildcards: drop beats reveal", () => {
    // inputs.*.email (2 literals, 3 segments) in both drop and reveal
    const r = new PolicyResolver({
      ...createDefaultPolicy(),
      drop: ["inputs.*.email"],
      reveal: ["inputs.*.email"],
    });
    expect(r.decide("inputs.user.email")).toBe("drop");
  });
});

// ---------------------------------------------------------------------------
// Unmatched-rule warnings (ADR-0009).
// ---------------------------------------------------------------------------

describe("PolicyResolver.unmatchedWarnings", () => {
  test("no rules → no warnings", () => {
    expect(new PolicyResolver().unmatchedWarnings()).toEqual([]);
  });

  test("rule that matched nothing is reported", () => {
    const r = new PolicyResolver({
      ...createDefaultPolicy(),
      drop: ["inputs.nonexistent_field"],
    });
    r.decide("inputs.user.email");
    const warnings = r.unmatchedWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("drop");
    expect(warnings[0]).toContain("inputs.nonexistent_field");
    expect(warnings[0]).toContain("matched no path");
  });

  test("rule that matched at least one path is not reported", () => {
    const r = new PolicyResolver({
      ...createDefaultPolicy(),
      reveal: ["inputs.user.email"],
    });
    r.decide("inputs.user.email");
    expect(r.unmatchedWarnings()).toEqual([]);
  });

  test("mixed: matched and unmatched rules", () => {
    const r = new PolicyResolver({
      ...createDefaultPolicy(),
      reveal: ["inputs.user.email", "outputs.nonexistent"],
    });
    r.decide("inputs.user.email");
    const warnings = r.unmatchedWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("outputs.nonexistent");
  });
});

// ---------------------------------------------------------------------------
// sanitizeRecord with policy — end-to-end disposition application.
// ---------------------------------------------------------------------------

describe("sanitizeRecord with policy", () => {
  const salt = Buffer.from("0123456789abcdef0123456789abcdef", "hex");

  test("zero-config (default policy) still tokenizes all string leaves", () => {
    const record = sampleRecord();
    const result = sanitizeRecord(record, salt);
    expect(result.id).toMatch(TOKEN_PATTERN);
    expect(result.trace_id).toMatch(TOKEN_PATTERN);
    expect((result.inputs as Record<string, unknown>).user_id).toMatch(TOKEN_PATTERN);
    expect((result.inputs as Record<string, unknown>).email).toMatch(TOKEN_PATTERN);
    expect(result.name).toBe("SearchTool");
    expect(result.kind).toBe("tool");
    expect(result.source.vendor).toBe("langsmith");
  });

  test("reveal keeps a field in plaintext", () => {
    const record = sampleRecord();
    const resolver = new PolicyResolver({
      ...createDefaultPolicy(),
      reveal: ["inputs.email"],
    });
    const result = sanitizeRecord(record, salt, resolver);
    expect((result.inputs as Record<string, unknown>).email).toBe("alice@corp.com");
    expect((result.inputs as Record<string, unknown>).user_id).toMatch(TOKEN_PATTERN);
  });

  test("drop removes a key from the object", () => {
    const record = sampleRecord();
    const resolver = new PolicyResolver({
      ...createDefaultPolicy(),
      drop: ["inputs.email"],
    });
    const result = sanitizeRecord(record, salt, resolver);
    expect((result.inputs as Record<string, unknown>).email).toBeUndefined();
    expect((result.inputs as Record<string, unknown>).user_id).toMatch(TOKEN_PATTERN);
  });

  test("drop on a required string field → tokenize (fail closed, can't remove)", () => {
    const record = sampleRecord();
    const resolver = new PolicyResolver({
      ...createDefaultPolicy(),
      drop: ["id"],
    });
    const result = sanitizeRecord(record, salt, resolver);
    expect(result.id).toMatch(TOKEN_PATTERN);
  });

  test("drop on inputs.user.email beats broader reveal: inputs.**", () => {
    const record = sampleRecord();
    const resolver = new PolicyResolver({
      ...createDefaultPolicy(),
      reveal: ["inputs.**"],
      drop: ["inputs.email"],
    });
    const result = sanitizeRecord(record, salt, resolver);
    expect((result.inputs as Record<string, unknown>).email).toBeUndefined();
    expect((result.inputs as Record<string, unknown>).user_id).toBe("u_123");
  });

  test("reveal on inputs.email beats broader drop: inputs.**", () => {
    const record = sampleRecord();
    const resolver = new PolicyResolver({
      ...createDefaultPolicy(),
      drop: ["inputs.**"],
      reveal: ["inputs.email"],
    });
    const result = sanitizeRecord(record, salt, resolver);
    expect((result.inputs as Record<string, unknown>).user_id).toBeUndefined();
  });

  test("tokenize narrows a broad reveal", () => {
    const record = sampleRecord();
    const resolver = new PolicyResolver({
      ...createDefaultPolicy(),
      reveal: ["inputs.**"],
      tokenize: ["inputs.user_id"],
    });
    const result = sanitizeRecord(record, salt, resolver);
    expect((result.inputs as Record<string, unknown>).user_id).toMatch(TOKEN_PATTERN);
    expect((result.inputs as Record<string, unknown>).email).toBe("alice@corp.com");
  });

  test("drop removes nested array element keys", () => {
    const record = sampleRecord();
    const resolver = new PolicyResolver({
      ...createDefaultPolicy(),
      drop: ["inputs.items[*].sku"],
    });
    const result = sanitizeRecord(record, salt, resolver);
    const items = (result.inputs as Record<string, unknown[]>).items;
    expect(items[0]).toEqual({});
  });

  test("drop on unmapped.note removes it", () => {
    const record = sampleRecord();
    const resolver = new PolicyResolver({
      ...createDefaultPolicy(),
      drop: ["unmapped.note"],
    });
    const result = sanitizeRecord(record, salt, resolver);
    expect((result.unmapped as Record<string, unknown>).note).toBeUndefined();
  });

  test("reveal on error.message keeps the plaintext", () => {
    const record: RawRecord = {
      ...sampleRecord(),
      status: "error",
      error: { kind: "timeout", message: "upstream timed out" },
    };
    const resolver = new PolicyResolver({
      ...createDefaultPolicy(),
      reveal: ["error.message"],
    });
    const result = sanitizeRecord(record, salt, resolver);
    expect(result.error?.message).toBe("upstream timed out");
    expect(result.error?.kind).toBe("timeout");
  });

  test("time: shift applies a constant offset to timestamps", () => {
    const record = sampleRecord();
    const resolver = new PolicyResolver({ ...createDefaultPolicy(), time: "shift" });
    const result = sanitizeRecord(record, salt, resolver);
    // Both timestamps shifted by the same constant — interval preserved.
    const originalInterval = Date.parse(record.end!) - Date.parse(record.start);
    const shiftedInterval = Date.parse(result.end!) - Date.parse(result.start);
    expect(shiftedInterval).toBe(originalInterval);
    expect(result.start).not.toBe(record.start);
    expect(result.end).not.toBe(record.end);
  });

  test("time: absolute leaves timestamps unchanged (default)", () => {
    const record = sampleRecord();
    const resolver = new PolicyResolver({ ...createDefaultPolicy(), time: "absolute" });
    const result = sanitizeRecord(record, salt, resolver);
    expect(result.start).toBe(record.start);
    expect(result.end).toBe(record.end);
  });

  test("reveal on labels[*].comment keeps free text", () => {
    const record = sampleRecord();
    const resolver = new PolicyResolver({
      ...createDefaultPolicy(),
      reveal: ["labels[*].comment"],
    });
    const result = sanitizeRecord(record, salt, resolver);
    expect(result.labels[0].comment).toBe("on point");
  });

  test("default policy tokenizes labels[*].comment", () => {
    const record = sampleRecord();
    const result = sanitizeRecord(record, salt);
    expect(result.labels[0].comment).toMatch(TOKEN_PATTERN);
  });
});
