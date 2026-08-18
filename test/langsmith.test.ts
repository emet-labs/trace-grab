import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readLangSmithExport } from "../src/sources/index.js";
import type { RawRecord } from "../src/normalize/index.js";

const FIXTURE_PATH = join(import.meta.dir, "fixtures", "langsmith-export.jsonl");

const workDirs: string[] = [];

function cleanup(): void {
  while (workDirs.length > 0) {
    const dir = workDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Write the named file under a fresh temp directory and return that directory path. */
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "trace-grab-langsmith-"));
  workDirs.push(dir);
  return dir;
}

describe("readLangSmithExport", () => {
  test("record count matches the fixture", () => {
    const records = readLangSmithExport(FIXTURE_PATH);
    expect(records).toHaveLength(7);
    cleanup();
  });

  test("known fields map correctly", () => {
    const records = readLangSmithExport(FIXTURE_PATH);
    const root = records.find((r) => r.id === "run-root-a")!;
    expect(root.name).toBe("AgentRun");
    expect(root.kind).toBe("chain");
    expect(root.start).toBe("2026-02-03T10:00:00.000Z");
    expect(root.end).toBe("2026-02-03T10:00:05.000Z");
    expect(root.inputs).toEqual({ question: "what is the policy?" });
    expect(root.outputs).toEqual({ answer: "see doc 42" });
    cleanup();
  });

  test("unrecognized top-level field appears in unmapped", () => {
    const records = readLangSmithExport(FIXTURE_PATH);
    const root = records.find((r) => r.id === "run-root-a")!;
    expect(root.unmapped["custom_field"]).toBe("value");
    expect(root.unmapped["tags"]).toEqual(["beta", "internal"]);

    const inflight = records.find((r) => r.id === "run-inflight-c")!;
    expect(inflight.unmapped["custom_field"]).toBe("still-here");
    cleanup();
  });

  test("null parent_run_id maps to a root (parent_id null)", () => {
    const records = readLangSmithExport(FIXTURE_PATH);
    const roots = records.filter((r) => r.parent_id === null);
    expect(roots.map((r) => r.id).sort()).toEqual(
      ["run-root-a", "run-root-b", "run-inflight-c"].sort(),
    );
    cleanup();
  });

  test("dangling parent_run_id is preserved verbatim, referencing an absent id", () => {
    const records = readLangSmithExport(FIXTURE_PATH);
    const ids = new Set(records.map((r) => r.id));
    const dangling = records.find((r) => r.id === "run-dangling-a3")!;
    expect(dangling.parent_id).toBe("run-absent-parent");
    expect(ids.has("run-absent-parent")).toBe(false);
    cleanup();
  });

  test("source.vendor is langsmith", () => {
    const records = readLangSmithExport(FIXTURE_PATH);
    for (const record of records) {
      expect(record.source.vendor).toBe("langsmith");
    }
    expect(records.every((r) => r.links.length === 0)).toBe(true);
    cleanup();
  });

  test("feedback and feedback_stats map to labels", () => {
    const records = readLangSmithExport(FIXTURE_PATH);
    const rootB = records.find((r) => r.id === "run-root-b")!;
    expect(rootB.labels).toContainEqual({
      key: "correctness",
      value: "correct",
      comment: "matched ground truth",
    });
    expect(rootB.labels).toContainEqual({ key: "helpfulness", value: 4, comment: null });

    const childA2 = records.find((r) => r.id === "run-child-a2")!;
    expect(childA2.labels).toEqual([
      { key: "correctness", value: "incorrect", comment: null },
    ]);
    cleanup();
  });

  test("status mapping and error normalization", () => {
    const records = readLangSmithExport(FIXTURE_PATH);
    const byId = new Map(records.map((r) => [r.id, r] as const));

    // success → ok, no error
    expect(byId.get("run-root-a")!.status).toBe("ok");
    expect(byId.get("run-root-a")!.error).toBeNull();

    // error status with a string error → { kind: "error", message }
    const a2 = byId.get("run-child-a2")!;
    expect(a2.status).toBe("error");
    expect(a2.error).toEqual({
      kind: "error",
      message: "upstream provider timed out after 30000ms",
    });

    // error status with an object error carrying kind/message
    const a3 = byId.get("run-dangling-a3")!;
    expect(a3.status).toBe("error");
    expect(a3.error).toEqual({ kind: "timeout", message: "retriever did not respond" });

    // unrecognized status ("running") → unset, no error field → null
    const inflight = byId.get("run-inflight-c")!;
    expect(inflight.status).toBe("unset");
    expect(inflight.error).toBeNull();
    expect(inflight.end).toBeNull();
    cleanup();
  });

  test("known metadata fields merge into attributes", () => {
    const records = readLangSmithExport(FIXTURE_PATH);
    const root = records.find((r) => r.id === "run-root-a")!;
    expect(root.attributes["session_id"]).toBe("sess-a-001");
    expect(root.attributes["dob"]).toBe("2026-02-03");
    expect(root.attributes["metadata"]).toEqual({
      environment: "production",
      request_id: "req-a-001",
    });
    expect(root.attributes["extra"]).toEqual({ runtime: "node", version: "20.10" });
    // attributes must NOT carry the known direct fields
    expect("inputs" in root.attributes).toBe(false);
    cleanup();
  });

  test("JSON bulk export { data: [...] } shape", () => {
    const dir = freshDir();
    const file = join(dir, "bulk.json");
    const runs: unknown[] = [
      {
        id: "bulk-1",
        trace_id: "bulk-trace",
        parent_run_id: null,
        name: "BulkRun",
        run_type: "chain",
        start_time: "2026-03-01T00:00:00.000Z",
        end_time: "2026-03-01T00:00:01.000Z",
        status: "success",
        inputs: null,
        outputs: null,
      },
      {
        id: "bulk-2",
        trace_id: "bulk-trace",
        parent_run_id: "bulk-1",
        name: "ChildRun",
        run_type: "tool",
        start_time: "2026-03-01T00:00:00.500Z",
        end_time: "2026-03-01T00:00:01.000Z",
        status: "success",
      },
    ];
    writeFileSync(file, JSON.stringify({ data: runs }));
    const records = readLangSmithExport(file);
    expect(records).toHaveLength(2);
    expect(records[0].id).toBe("bulk-1");
    expect(records[1].parent_id).toBe("bulk-1");
    cleanup();
  });

  test("directory of mixed JSON and JSONL files is sorted for determinism", () => {
    const dir = freshDir();
    // Write out of order; parser must sort alphabetically.
    writeFileSync(
      join(dir, "b.jsonl"),
      '{"id":"dir-b","trace_id":"t","parent_run_id":null,"name":"B","run_type":"tool","start_time":"2026-01-01T00:00:00.000Z","end_time":"2026-01-01T00:00:01.000Z","status":"success"}\n',
    );
    writeFileSync(
      join(dir, "a.json"),
      JSON.stringify([
        {
          id: "dir-a",
          trace_id: "t",
          parent_run_id: null,
          name: "A",
          run_type: "chain",
          start_time: "2026-01-01T00:00:00.000Z",
          end_time: "2026-01-01T00:00:01.000Z",
          status: "success",
        },
      ]),
    );
    // Create a subdirectory with its own jsonl to confirm non-recursive top-level globbing.
    mkdirSync(join(dir, "nested"));
    writeFileSync(
      join(dir, "nested", "c.jsonl"),
      '{"id":"dir-c","trace_id":"t","parent_run_id":null,"name":"C","run_type":"llm","start_time":"2026-01-01T00:00:00.000Z","status":"running"}\n',
    );
    const records: RawRecord[] = readLangSmithExport(dir);
    expect(records.map((r) => r.id)).toEqual(["dir-a", "dir-b"]);
    cleanup();
  });
});
