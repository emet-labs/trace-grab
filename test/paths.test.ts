import { describe, expect, test } from "bun:test";

import { compareSpecificity, literalSegmentCount, matchPath, segmentCount, splitPath } from "../src/sanitize/paths.js";

describe("splitPath", () => {
  test("splits a dotted path into segments", () => {
    expect(splitPath("inputs.user.email")).toEqual(["inputs", "user", "email"]);
  });

  test("keeps the array-element suffix attached to its parent segment", () => {
    expect(splitPath("inputs.items[*].sku")).toEqual(["inputs", "items[*]", "sku"]);
  });
});

describe("matchPath", () => {
  const cases: Array<[string, string, boolean, string]> = [
    // exact match
    ["inputs.user.email", "inputs.user.email", true, "exact match"],
    ["inputs.items[*].sku", "inputs.items[*].sku", true, "exact array-element match"],
    // `*` matches exactly one segment
    ["inputs.*.email", "inputs.user.email", true, "`*` mid-path"],
    ["inputs.*.email", "inputs.user.name", false, "`*` does not cross a mismatch"],
    ["inputs.*.sku", "inputs.items[*].sku", true, "`*` matches an array-element segment"],
    ["inputs.*", "inputs", false, "`*` requires exactly one segment, not zero"],
    ["inputs.*.*", "inputs.user.email", true, "two `*` match two segments"],
    // trailing `**`
    ["inputs.**", "inputs.user.email", true, "trailing `**` matches any depth"],
    ["inputs.**", "inputs", true, "`**` matches zero segments"],
    ["**", "inputs.user.email", true, "leading `**` matches everything"],
    // array collapse: object key vs array element are distinct segments
    ["inputs.items.sku", "inputs.items[*].sku", false, "object key does not match array element"],
    ["inputs.items[*].sku", "inputs.items.sku", false, "array element does not match object key"],
    // non-matches
    ["inputs.user.email", "inputs.user.name", false, "literal mismatch"],
    ["inputs.user.email", "inputs.user", false, "pattern longer than path"],
    ["inputs.user", "inputs.user.email", false, "path longer than pattern"],
    ["inputs.user.email", "outputs.user.email", false, "top-level mismatch"],
  ];

  for (const [pattern, path, expected, name] of cases) {
    test(name, () => {
      expect(matchPath(pattern, path)).toBe(expected);
    });
  }
});

describe("matchPath — no regex blowup", () => {
  test("a pattern with many `**` matches a short path without exponential work", () => {
    const pattern = Array.from({ length: 20 }, () => "**").join(".");
    expect(matchPath(pattern, "a.b.c")).toBe(true);
  });

  test("interleaved wildcards still match correctly", () => {
    expect(matchPath("a.**.b.**.c", "a.x.y.b.c")).toBe(true);
    expect(matchPath("a.**.b.**.c", "a.b.c")).toBe(true);
    expect(matchPath("a.**.b.**.c", "a.x.c")).toBe(false);
  });
});

describe("specificity", () => {
  test("literal and total segment counts", () => {
    expect(literalSegmentCount("inputs.user.email")).toBe(3);
    expect(literalSegmentCount("inputs.*.email")).toBe(2);
    expect(literalSegmentCount("inputs.**")).toBe(1);
    expect(literalSegmentCount("**")).toBe(0);

    expect(segmentCount("inputs.user.email")).toBe(3);
    expect(segmentCount("inputs.**")).toBe(2);
    expect(segmentCount("**")).toBe(1);
  });

  test("orders exactly per ADR-0009's precedence example", () => {
    const ordered = ["inputs.user.email", "inputs.*.email", "inputs.**", "**"];
    const sorted = [...ordered].sort(compareSpecificity);
    expect(sorted).toEqual(ordered);
  });

  test("an exact match beats a wildcard-suffixed one at the same literal depth", () => {
    expect(compareSpecificity("inputs", "inputs.**")).toBeLessThan(0);
    expect(compareSpecificity("inputs.**", "inputs")).toBeGreaterThan(0);
  });

  test("equal patterns tie", () => {
    expect(compareSpecificity("inputs.user.email", "inputs.user.email")).toBe(0);
    expect(compareSpecificity("**", "*")).toBe(0);
  });
});
