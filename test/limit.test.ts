import { describe, expect, test } from "bun:test";

import { limitTraces } from "../src/limit/index.js";
import type { RawRecord } from "../src/normalize/index.js";

/** Build a RawRecord with sensible defaults; only the identity/timing/parentage
 *  fields vary between tests. */
function makeRecord(overrides: Partial<RawRecord> & { id: string; trace_id: string }): RawRecord {
  return {
    parent_id: null,
    name: "op",
    kind: "llm",
    start: "2026-01-01T08:00:00.000Z",
    end: "2026-01-01T08:00:01.000Z",
    status: "ok",
    error: null,
    inputs: {},
    outputs: {},
    attributes: {},
    labels: [],
    links: [],
    unmapped: {},
    source: { vendor: "generic" },
    ...overrides,
  };
}

/** Distinct trace ids among kept records, in first-appearance order. */
function keptTraceIds(kept: RawRecord[]): string[] {
  const order: string[] = [];
  for (const record of kept) {
    if (!order.includes(record.trace_id)) order.push(record.trace_id);
  }
  return order;
}

describe("limitTraces — window filtering", () => {
  test("traces whose root start is outside the window are excluded entirely", () => {
    const records: RawRecord[] = [
      makeRecord({ id: "a-root", trace_id: "A", start: "2026-01-01T08:00:00.000Z" }),
      makeRecord({ id: "a-child", trace_id: "A", parent_id: "a-root", start: "2026-01-01T08:00:05.000Z" }),
      makeRecord({ id: "b-root", trace_id: "B", start: "2026-01-01T10:00:00.000Z" }),
      makeRecord({ id: "b-child", trace_id: "B", parent_id: "b-root", start: "2026-01-01T10:00:05.000Z" }),
    ];

    const result = limitTraces(records, { since: "2026-01-01T09:00:00.000Z" });

    expect(keptTraceIds(result.kept)).toEqual(["B"]);
    expect(result.excludedByWindow).toBe(1);
    expect(result.excludedByLimit).toBe(0);
    // Both B's root and its child survive — the whole trace came through.
    expect(result.kept.map((r) => r.id).sort()).toEqual(["b-child", "b-root"]);
  });

  test("window bounds are inclusive on both ends", () => {
    const records: RawRecord[] = [
      makeRecord({ id: "at-since", trace_id: "S", start: "2026-01-01T09:00:00.000Z" }),
      makeRecord({ id: "at-until", trace_id: "U", start: "2026-01-01T11:00:00.000Z" }),
      makeRecord({ id: "before", trace_id: "X", start: "2026-01-01T08:59:59.999Z" }),
      makeRecord({ id: "after", trace_id: "Y", start: "2026-01-01T11:00:00.001Z" }),
    ];

    const result = limitTraces(records, {
      since: "2026-01-01T09:00:00.000Z",
      until: "2026-01-01T11:00:00.000Z",
    });

    expect(keptTraceIds(result.kept).sort()).toEqual(["S", "U"]);
    expect(result.excludedByWindow).toBe(2);
  });

  test("window uses the root start time, not per-record times", () => {
    // Root is inside the window; a child starts before the window and a child after.
    // Because filtering is by root, the whole trace is kept.
    const insideRoot: RawRecord[] = [
      makeRecord({ id: "root", trace_id: "T", start: "2026-01-01T10:00:00.000Z" }),
      makeRecord({ id: "early-child", trace_id: "T", parent_id: "root", start: "2026-01-01T07:00:00.000Z" }),
      makeRecord({ id: "late-child", trace_id: "T", parent_id: "root", start: "2026-01-01T12:00:00.000Z" }),
    ];
    const keptRoot = limitTraces(insideRoot, {
      since: "2026-01-01T09:00:00.000Z",
      until: "2026-01-01T11:00:00.000Z",
    });
    expect(keptRoot.kept.map((r) => r.id).sort()).toEqual(["early-child", "late-child", "root"]);
    expect(keptRoot.excludedByWindow).toBe(0);

    // Conversely: a child is inside the window but the root is outside → excluded.
    const outsideRoot: RawRecord[] = [
      makeRecord({ id: "root2", trace_id: "T2", start: "2026-01-01T06:00:00.000Z" }),
      makeRecord({ id: "mid-child", trace_id: "T2", parent_id: "root2", start: "2026-01-01T10:00:00.000Z" }),
    ];
    const excludedRoot = limitTraces(outsideRoot, {
      since: "2026-01-01T09:00:00.000Z",
      until: "2026-01-01T11:00:00.000Z",
    });
    expect(excludedRoot.kept).toEqual([]);
    expect(excludedRoot.excludedByWindow).toBe(1);
  });

  test("a trace with no root is filtered by its earliest-start record", () => {
    const records: RawRecord[] = [
      makeRecord({ id: "no-root-1", trace_id: "NR", parent_id: "ghost", start: "2026-01-01T12:00:00.000Z" }),
      makeRecord({ id: "no-root-2", trace_id: "NR", parent_id: "ghost2", start: "2026-01-01T06:00:00.000Z" }),
    ];

    const result = limitTraces(records, {
      since: "2026-01-01T09:00:00.000Z",
      until: "2026-01-01T11:00:00.000Z",
    });

    // Earliest start (06:00) is before the window → whole trace excluded.
    expect(result.kept).toEqual([]);
    expect(result.excludedByWindow).toBe(1);
  });
});

describe("limitTraces — max-traces selection", () => {
  /** Eight single-span traces with distinct root ids. */
  function eightTraces(): RawRecord[] {
    const records: RawRecord[] = [];
    for (let i = 0; i < 8; i += 1) {
      records.push(
        makeRecord({ id: `root-${i}`, trace_id: `trace-${i}`, start: "2026-01-01T08:00:00.000Z" }),
      );
    }
    return records;
  }

  test("a larger max-traces yields a strict superset of a smaller one", () => {
    const records = eightTraces();

    const three = limitTraces(records, { maxTraces: 3 });
    const six = limitTraces(records, { maxTraces: 6 });

    expect(three.kept.length).toBe(3);
    expect(six.kept.length).toBe(6);
    expect(three.excludedByLimit).toBe(5);
    expect(six.excludedByLimit).toBe(2);
    expect(three.excludedByWindow).toBe(0);
    expect(six.excludedByWindow).toBe(0);

    const threeIds = new Set(keptTraceIds(three.kept));
    const sixIds = new Set(keptTraceIds(six.kept));
    for (const id of threeIds) {
      expect(sixIds.has(id), `trace ${id} in N=3 should also be in N=6`).toBe(true);
    }
  });

  test("selection is deterministic across repeated calls on the same input", () => {
    const records = eightTraces();
    const first = limitTraces(records, { maxTraces: 4 });
    const second = limitTraces(records, { maxTraces: 4 });

    expect(keptTraceIds(first.kept)).toEqual(keptTraceIds(second.kept));
    expect(first.excludedByLimit).toBe(second.excludedByLimit);
  });

  test("maxTraces greater than the trace count keeps everything", () => {
    const records = eightTraces();
    const result = limitTraces(records, { maxTraces: 100 });
    expect(result.kept.length).toBe(8);
    expect(result.excludedByLimit).toBe(0);
    expect(result.excludedByWindow).toBe(0);
  });

  test("maxTraces of zero excludes every surviving trace by limit", () => {
    const records = eightTraces();
    const result = limitTraces(records, { maxTraces: 0 });
    expect(result.kept).toEqual([]);
    expect(result.excludedByLimit).toBe(8);
    expect(result.excludedByWindow).toBe(0);
  });
});

describe("limitTraces — whole-trace integrity", () => {
  test("no selected trace is missing a descendant that existed in the input", () => {
    // trace-K is a deep chain; trace-L is a single span. Limit to 1 trace.
    const records: RawRecord[] = [
      makeRecord({ id: "k-0", trace_id: "K", start: "2026-01-01T08:00:00.000Z" }),
      makeRecord({ id: "k-1", trace_id: "K", parent_id: "k-0", start: "2026-01-01T08:00:01.000Z" }),
      makeRecord({ id: "k-2", trace_id: "K", parent_id: "k-1", start: "2026-01-01T08:00:02.000Z" }),
      makeRecord({ id: "k-3", trace_id: "K", parent_id: "k-2", start: "2026-01-01T08:00:03.000Z" }),
      makeRecord({ id: "l-0", trace_id: "L", start: "2026-01-01T08:00:00.000Z" }),
    ];

    const result = limitTraces(records, { maxTraces: 1 });
    expect(result.kept.length).toBeGreaterThanOrEqual(1);

    // Whatever trace survived, every input record of that trace must be present.
    const keptByTrace = new Map<string, RawRecord[]>();
    for (const r of result.kept) {
      const group = keptByTrace.get(r.trace_id) ?? [];
      group.push(r);
      keptByTrace.set(r.trace_id, group);
    }
    for (const [traceId, keptRecords] of keptByTrace) {
      const inputIds = records.filter((r) => r.trace_id === traceId).map((r) => r.id).sort();
      expect(keptRecords.map((r) => r.id).sort()).toEqual(inputIds);
    }
  });

  test("a dangling parent reference is preserved, not dropped or repaired", () => {
    const records: RawRecord[] = [
      makeRecord({ id: "d-root", trace_id: "D", start: "2026-01-01T08:00:00.000Z" }),
      makeRecord({
        id: "d-dangling",
        trace_id: "D",
        parent_id: "span-missing-parent",
        start: "2026-01-01T08:00:01.000Z",
      }),
    ];

    const result = limitTraces(records, {});
    const dangling = result.kept.find((r) => r.id === "d-dangling");
    expect(dangling).toBeDefined();
    expect(dangling?.parent_id).toBe("span-missing-parent");
    expect(result.excludedByWindow).toBe(0);
    expect(result.excludedByLimit).toBe(0);
  });

  test("kept records preserve original order within each trace and trace order from input", () => {
    // Interleave two traces in the input; the kept output groups them in trace-appearance
    // order, with each trace's records in their original relative order.
    const records: RawRecord[] = [
      makeRecord({ id: "a-0", trace_id: "A", start: "2026-01-01T08:00:00.000Z" }),
      makeRecord({ id: "b-0", trace_id: "B", start: "2026-01-01T08:00:00.000Z" }),
      makeRecord({ id: "a-1", trace_id: "A", parent_id: "a-0", start: "2026-01-01T08:00:01.000Z" }),
      makeRecord({ id: "b-1", trace_id: "B", parent_id: "b-0", start: "2026-01-01T08:00:01.000Z" }),
      makeRecord({ id: "a-2", trace_id: "A", parent_id: "a-1", start: "2026-01-01T08:00:02.000Z" }),
    ];

    const result = limitTraces(records, {});
    expect(result.kept.map((r) => r.id)).toEqual(["a-0", "a-1", "a-2", "b-0", "b-1"]);
  });
});

describe("limitTraces — window + limit combined", () => {
  test("limit applies after window, and counts are separated", () => {
    // 6 traces: 2 outside the window, 4 inside. maxTraces 2 → 2 kept, 2 excluded by limit.
    const records: RawRecord[] = [
      makeRecord({ id: "early-0", trace_id: "E0", start: "2026-01-01T06:00:00.000Z" }),
      makeRecord({ id: "early-1", trace_id: "E1", start: "2026-01-01T06:30:00.000Z" }),
      makeRecord({ id: "mid-0", trace_id: "M0", start: "2026-01-01T10:00:00.000Z" }),
      makeRecord({ id: "mid-1", trace_id: "M1", start: "2026-01-01T10:30:00.000Z" }),
      makeRecord({ id: "mid-2", trace_id: "M2", start: "2026-01-01T11:00:00.000Z" }),
      makeRecord({ id: "mid-3", trace_id: "M3", start: "2026-01-01T11:30:00.000Z" }),
    ];

    const result = limitTraces(records, {
      since: "2026-01-01T09:00:00.000Z",
      until: "2026-01-01T12:00:00.000Z",
      maxTraces: 2,
    });

    expect(result.excludedByWindow).toBe(2);
    expect(result.excludedByLimit).toBe(2);
    expect(keptTraceIds(result.kept).length).toBe(2);

    // The two kept must be a subset of the four inside-window traces, and the
    // superset property holds against maxTraces 4 over the same input.
    const four = limitTraces(records, {
      since: "2026-01-01T09:00:00.000Z",
      until: "2026-01-01T12:00:00.000Z",
      maxTraces: 4,
    });
    expect(four.excludedByLimit).toBe(0);
    expect(four.kept.length).toBe(4);
    const twoIds = new Set(keptTraceIds(result.kept));
    for (const id of twoIds) {
      expect(keptTraceIds(four.kept)).toContain(id);
    }
  });
});
