import { createHash } from "node:crypto";

import type { RawRecord } from "../normalize/index.js";

export interface LimitOptions {
  /** ISO-8601 lower bound (inclusive) on a trace's root start time. */
  since?: string;
  /** ISO-8601 upper bound (inclusive) on a trace's root start time. */
  until?: string;
  /** Deterministic cap on the number of traces kept (after window filtering). */
  maxTraces?: number;
}

export interface LimitResult {
  /** Surviving records, in original trace order and original order within each trace. */
  kept: RawRecord[];
  /** Number of whole traces excluded because their root start fell outside the window. */
  excludedByWindow: number;
  /** Number of whole traces excluded by `--max-traces` (after window filtering). */
  excludedByLimit: number;
}

interface TraceGroup {
  traceId: string;
  records: RawRecord[];
  root: RawRecord;
  rootStartMs: number;
}

/**
 * Pick the representative root span for a trace group. Prefers a `parent_id === null`
 * record (first by input order); if the trace has no root, falls back to the record
 * with the earliest `start` time (first by input order on ties). The choice is
 * deterministic so re-runs hash the same root id and compare the same start time.
 */
function pickRoot(records: RawRecord[]): RawRecord {
  for (const record of records) {
    if (record.parent_id === null) return record;
  }
  let earliest = records[0] as RawRecord;
  let earliestMs = Date.parse(earliest.start);
  for (let i = 1; i < records.length; i += 1) {
    const record = records[i] as RawRecord;
    const ms = Date.parse(record.start);
    if (ms < earliestMs) {
      earliest = record;
      earliestMs = ms;
    }
  }
  return earliest;
}

/**
 * Whole-trace limiting (ADR-0011). A trace is wholly in or wholly out — never sampled
 * per span. Window filtering compares the trace's root start time against `since`/`until`
 * (inclusive bounds), never individual record times. Max-traces selection is deterministic:
 * each surviving root's `id` is SHA-256 hashed, roots are sorted by that hash, and the first
 * N are kept — so a larger N yields a strict superset of a smaller N over the same input.
 *
 * Both exclusion counts are trace counts, not record counts.
 */
export function limitTraces(records: RawRecord[], opts: LimitOptions): LimitResult {
  const sinceMs = opts.since !== undefined ? Date.parse(opts.since) : undefined;
  const untilMs = opts.until !== undefined ? Date.parse(opts.until) : undefined;

  // Group by trace_id, preserving first-appearance order of traces.
  const order: string[] = [];
  const byTrace = new Map<string, RawRecord[]>();
  for (const record of records) {
    const group = byTrace.get(record.trace_id);
    if (group === undefined) {
      order.push(record.trace_id);
      byTrace.set(record.trace_id, [record]);
    } else {
      group.push(record);
    }
  }

  const allTraces: TraceGroup[] = order.map((traceId) => {
    const traceRecords = byTrace.get(traceId) as RawRecord[];
    const root = pickRoot(traceRecords);
    return { traceId, records: traceRecords, root, rootStartMs: Date.parse(root.start) };
  });

  // Window filter: exclude whole traces whose root start is outside [since, until].
  const surviving: TraceGroup[] = [];
  let excludedByWindow = 0;
  for (const trace of allTraces) {
    const beforeSince = sinceMs !== undefined && !Number.isNaN(sinceMs) && trace.rootStartMs < sinceMs;
    const afterUntil = untilMs !== undefined && !Number.isNaN(untilMs) && trace.rootStartMs > untilMs;
    if (beforeSince || afterUntil) {
      excludedByWindow += 1;
    } else {
      surviving.push(trace);
    }
  }

  // Max-traces filter: deterministic selection by SHA-256 of the root id.
  let excludedByLimit = 0;
  let keptTraces: TraceGroup[];
  if (opts.maxTraces !== undefined && surviving.length > 0) {
    const take = Math.max(0, Math.floor(opts.maxTraces));
    const ranked = surviving
      .map((trace) => ({
        trace,
        hash: createHash("sha256").update(trace.root.id).digest("hex"),
      }))
      .sort((a, b) => {
        if (a.hash !== b.hash) return a.hash < b.hash ? -1 : 1;
        // Impossible in practice (SHA-256), but pins total determinism.
        return a.trace.root.id < b.trace.root.id ? -1 : 1;
      });
    const selected = new Set(ranked.slice(0, take).map((entry) => entry.trace.traceId));
    keptTraces = surviving.filter((trace) => selected.has(trace.traceId));
    excludedByLimit = surviving.length - selected.size;
  } else {
    keptTraces = surviving;
    excludedByLimit = 0;
  }

  // Emit kept records: traces in input order, records in input order within each trace.
  const kept: RawRecord[] = [];
  for (const trace of keptTraces) {
    for (const record of trace.records) {
      kept.push(record);
    }
  }

  return { kept, excludedByWindow, excludedByLimit };
}
