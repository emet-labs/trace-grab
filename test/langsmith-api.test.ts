import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearLangSmithCheckpoint,
  fetchLangSmithProject,
  LangSmithApiError,
} from "../src/sources/langsmith-api.js";
import { grab, printGrabFailure } from "../src/cli.js";

const workDirs: string[] = [];
const originalApiKey = process.env["LANGSMITH_API_KEY"];
const originalEndpoint = process.env["LANGSMITH_ENDPOINT"];

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function freshDir(): string {
  const path = mkdtempSync(join(tmpdir(), "trace-grab-langsmith-api-"));
  workDirs.push(path);
  return path;
}

function run(id: string): Record<string, unknown> {
  return {
    id,
    trace_id: "trace-1",
    parent_run_id: null,
    name: `Run ${id}`,
    run_type: "chain",
    start_time: "2026-01-01T00:00:00.000Z",
    end_time: "2026-01-01T00:00:01.000Z",
    status: "success",
  };
}

function filesUnder(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { recursive: true, encoding: "utf8" })) {
    const path = join(root, entry);
    if (statSync(path).isFile()) files.push(path);
  }
  return files;
}

afterEach(() => {
  while (workDirs.length > 0) rmSync(workDirs.pop()!, { recursive: true, force: true });
  restoreEnvironment("LANGSMITH_API_KEY", originalApiKey);
  restoreEnvironment("LANGSMITH_ENDPOINT", originalEndpoint);
});

describe("fetchLangSmithProject", () => {
  test("missing environment key fails actionably before any request", async () => {
    delete process.env["LANGSMITH_API_KEY"];
    let requests = 0;
    const request = async (): Promise<Response> => {
      requests += 1;
      return Response.json([]);
    };

    await expect(
      fetchLangSmithProject("project", { request }),
    ).rejects.toThrow("LANGSMITH_API_KEY is required");
    expect(requests).toBe(0);
  });

  test("uses the documented endpoints and cursor-paginates native runs through the parser", async () => {
    process.env["LANGSMITH_API_KEY"] = "secret-key";
    process.env["LANGSMITH_ENDPOINT"] = "https://langsmith.example.test/";
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const responses = [
      Response.json([{ id: "project-id" }]),
      Response.json({
        runs: [{ ...run("run-1"), inputs: { ordinary_trace_data: "customer-value" } }],
        cursors: { next: "next-page" },
      }),
      Response.json({ runs: [run("run-2")], cursors: { next: null } }),
    ];
    const request = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), init: init ?? {} });
      return responses.shift()!;
    };

    const result = await fetchLangSmithProject("my project", {
      checkpointRoot: freshDir(),
      request,
    });

    expect(result.records.map((record) => record.id)).toEqual(["run-1", "run-2"]);
    expect(calls.map((call) => [call.init.method, call.url])).toEqual([
      ["GET", "https://langsmith.example.test/api/v1/sessions?name=my+project"],
      ["POST", "https://langsmith.example.test/api/v1/runs/query"],
      ["POST", "https://langsmith.example.test/api/v1/runs/query"],
    ]);
    expect(calls.every((call) => call.init.redirect === "error")).toBe(true);
    expect((calls[0]!.init.headers as Record<string, string>)["x-api-key"]).toBe("secret-key");
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({
      session: ["project-id"],
      limit: 100,
      order: "asc",
    });
    expect(JSON.parse(calls[2]!.init.body as string).cursor).toBe("next-page");
    expect(statSync(result.checkpointPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(result.checkpointPath, "utf8")).not.toContain("secret-key");
    clearLangSmithCheckpoint(result.checkpointPath);
  });

  test("a rerun resumes after a mid-pull 429 and does not duplicate records", async () => {
    const root = freshDir();
    const key = "ls-secret-resume";
    process.env["LANGSMITH_API_KEY"] = key;
    const firstResponses = [
      Response.json([{ id: "project-id" }]),
      Response.json({
        runs: [{ ...run("run-1"), inputs: { preserved_on_resume: "native-marker" } }],
        cursors: { next: "page-2" },
      }),
      new Response(`rate limited for ${key}`, { status: 429, statusText: "Too Many Requests" }),
    ];
    const firstRequest = async (): Promise<Response> => firstResponses.shift()!;

    let firstError: unknown;
    try {
      await fetchLangSmithProject("project", {
        checkpointRoot: root,
        request: firstRequest,
        maxRateLimitRetries: 0,
      });
    } catch (error) {
      firstError = error;
    }
    expect(firstError).toBeInstanceOf(LangSmithApiError);
    expect(String(firstError)).toContain("[REDACTED]");
    expect((firstError as Error).stack).not.toContain(key);
    const printed: string[] = [];
    const originalError = console.error;
    try {
      console.error = (...values: unknown[]) => printed.push(values.map(String).join(" "));
      printGrabFailure(firstError, "langsmith-api");
    } finally {
      console.error = originalError;
    }
    expect(printed.join("\n")).toContain("[REDACTED]");
    expect(printed.join("\n")).not.toContain(key);

    const resumedBodies: Record<string, unknown>[] = [];
    const resumedResponses = [
      Response.json([{ id: "project-id" }]),
      Response.json({
        // An overlapping item is harmless even if an API cursor repeats its boundary record.
        runs: [run("run-1"), run("run-2")],
        cursors: { next: null },
      }),
    ];
    const resumedRequest = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (init?.body) resumedBodies.push(JSON.parse(init.body as string));
      return resumedResponses.shift()!;
    };
    const resumed = await fetchLangSmithProject("project", {
      checkpointRoot: root,
      request: resumedRequest,
    });

    expect(resumedBodies).toHaveLength(1);
    expect(resumedBodies[0]!["cursor"]).toBe("page-2");
    expect(resumed.records.map((record) => record.id)).toEqual(["run-1", "run-2"]);
    expect(resumed.records[0]!.inputs).toEqual({ preserved_on_resume: "native-marker" });
    expect(readFileSync(resumed.checkpointPath, "utf8")).not.toContain(key);
  });

  test("backs off and retries a rate-limited request", async () => {
    process.env["LANGSMITH_API_KEY"] = "key";
    const delays: number[] = [];
    const responses = [
      new Response("slow down", { status: 429, headers: { "retry-after": "2" } }),
      Response.json([{ id: "project-id" }]),
      Response.json({ runs: [], cursors: { next: null } }),
    ];
    const result = await fetchLangSmithProject("project", {
      checkpointRoot: freshDir(),
      request: async () => responses.shift()!,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });
    expect(delays).toEqual([2000]);
    expect(result.records).toEqual([]);
  });

  test("refuses a successful response containing the active key before checkpointing it", async () => {
    const root = freshDir();
    const key = "ls-secret-that-must-never-reach-disk";
    const policyPath = join(root, "policy.yaml");
    writeFileSync(policyPath, "version: 1\nreveal:\n  - inputs.accidentally_traced\n");
    process.env["LANGSMITH_API_KEY"] = key;
    process.env["LANGSMITH_ENDPOINT"] = "https://langsmith.example.test";
    const responses = [
      Response.json([{ id: "project-id" }]),
      Response.json({
        runs: [{ ...run("run-1"), inputs: { accidentally_traced: key } }],
        cursors: { next: null },
      }),
    ];
    const originalFetch = globalThis.fetch;
    const originalCwd = process.cwd();
    const originalLog = console.log;
    try {
      globalThis.fetch = async () => responses.shift()!;
      console.log = () => undefined;
      process.chdir(root);
      await expect(
        grab([
          "--from",
          "langsmith-api",
          "project",
          "--out",
          join(root, "out"),
          "--policy",
          policyPath,
        ]),
      ).rejects.toThrow("refusing to persist that page");
    } finally {
      process.chdir(originalCwd);
      globalThis.fetch = originalFetch;
      console.log = originalLog;
    }
    for (const path of filesUnder(root)) {
      expect(readFileSync(path).toString("utf8"), path).not.toContain(key);
    }
  });

});

describe("CLI langsmith-api source", () => {
  test("without a key it exits actionably and before network access", () => {
    const root = freshDir();
    const cliPath = join(import.meta.dir, "..", "src", "cli.ts");
    const env = { ...process.env };
    delete env["LANGSMITH_API_KEY"];
    const result = spawnSync(
      process.execPath,
      [cliPath, "grab", "--from", "langsmith-api", "project", "--out", join(root, "out")],
      { cwd: root, env, encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("LANGSMITH_API_KEY is required");
  });

  test("rejects an API key flag without echoing its value", () => {
    const root = freshDir();
    const cliPath = join(import.meta.dir, "..", "src", "cli.ts");
    const result = spawnSync(
      process.execPath,
      [
        cliPath,
        "grab",
        "--from",
        "langsmith-api",
        "project",
        "--api-key",
        "must-not-appear",
        "--out",
        join(root, "out"),
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("set LANGSMITH_API_KEY in the environment");
    expect(result.stderr).not.toContain("must-not-appear");
  });
});
