import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { dirname, join } from "node:path";

import type { RawRecord } from "../normalize/index.js";
import { parseLangSmithRuns } from "./langsmith.js";

const DEFAULT_BASE_URL = "https://api.smith.langchain.com";
const CHECKPOINT_VERSION = 1;
const PAGE_LIMIT = 100;

interface Checkpoint {
  version: typeof CHECKPOINT_VERSION;
  requestHash: string;
  cursor: string | null;
  complete: boolean;
  runs: unknown[];
}

interface StoredCheckpoint extends Omit<Checkpoint, "cursor" | "complete" | "runs"> {
  nonce: string;
  authTag: string;
  payload: string;
}

interface RunsPage {
  runs: unknown[];
  cursors?: { next?: string | null };
}

export interface LangSmithFetchOptions {
  checkpointRoot?: string;
  request?: typeof globalThis.fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  maxRateLimitRetries?: number;
}

export interface LangSmithFetchResult {
  records: RawRecord[];
  checkpointPath: string;
}

export class LangSmithApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LangSmithApiError";
  }
}

/** Replace every literal occurrence of the credential before an error leaves this module. */
export function redactLangSmithSecret(text: string, apiKey: string): string {
  return apiKey.length === 0 ? text : text.split(apiKey).join("[REDACTED]");
}

export function containsLangSmithSecret(value: unknown, apiKey: string): boolean {
  if (typeof value === "string") return value.includes(apiKey);
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => containsLangSmithSecret(item, apiKey));
  return Object.entries(value).some(
    ([key, item]) => key.includes(apiKey) || containsLangSmithSecret(item, apiKey),
  );
}

function safeError(error: unknown, apiKey: string): LangSmithApiError {
  const message = error instanceof Error ? error.message : String(error);
  return new LangSmithApiError(redactLangSmithSecret(message, apiKey));
}

function normalizedBaseUrl(raw: string, apiKey: string): string {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("LANGSMITH_ENDPOINT must use http or https");
    }
    if (parsed.username || parsed.password) {
      throw new Error("LANGSMITH_ENDPOINT must not contain credentials");
    }
    parsed.hash = "";
    parsed.search = "";
    return parsed.href.replace(/\/$/, "");
  } catch (error) {
    throw safeError(error, apiKey);
  }
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl}${path}`;
}

function requestHash(request: string): string {
  return createHash("sha256").update(request).digest("hex");
}

function checkpointPath(root: string, hash: string): string {
  return join(root, ".trace-grab", "langsmith-api", `${hash.slice(0, 16)}.json`);
}

function checkpointKey(apiKey: string): Buffer {
  return createHash("sha256")
    .update("trace-grab/langsmith-api/checkpoint/v1\0")
    .update(apiKey)
    .digest();
}

function encryptCheckpointPayload(
  checkpoint: Pick<Checkpoint, "cursor" | "complete" | "runs">,
  hash: string,
  apiKey: string,
): Pick<StoredCheckpoint, "nonce" | "authTag" | "payload"> {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", checkpointKey(apiKey), nonce);
  cipher.setAAD(Buffer.from(hash));
  const payload = Buffer.concat([
    cipher.update(JSON.stringify(checkpoint), "utf8"),
    cipher.final(),
  ]);
  return {
    nonce: nonce.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    payload: payload.toString("base64"),
  };
}

function decryptCheckpointPayload(
  stored: StoredCheckpoint,
  apiKey: string,
): Pick<Checkpoint, "cursor" | "complete" | "runs"> {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    checkpointKey(apiKey),
    Buffer.from(stored.nonce, "base64"),
  );
  decipher.setAAD(Buffer.from(stored.requestHash));
  decipher.setAuthTag(Buffer.from(stored.authTag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(stored.payload, "base64")),
    decipher.final(),
  ]).toString("utf8");
  const payload = JSON.parse(plaintext) as Partial<
    Pick<Checkpoint, "cursor" | "complete" | "runs">
  >;
  if (
    !Array.isArray(payload.runs) ||
    (payload.cursor !== null && typeof payload.cursor !== "string") ||
    typeof payload.complete !== "boolean"
  ) {
    throw new Error("checkpoint payload is invalid");
  }
  return payload as Pick<Checkpoint, "cursor" | "complete" | "runs">;
}

function readCheckpoint(path: string, hash: string, apiKey: string): Checkpoint {
  if (!existsSync(path)) {
    return { version: CHECKPOINT_VERSION, requestHash: hash, cursor: null, complete: false, runs: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StoredCheckpoint>;
    if (
      parsed.version !== CHECKPOINT_VERSION ||
      parsed.requestHash !== hash ||
      typeof parsed.nonce !== "string" ||
      typeof parsed.authTag !== "string" ||
      typeof parsed.payload !== "string"
    ) {
      throw new Error(`invalid LangSmith checkpoint: ${path}`);
    }
    const stored = parsed as StoredCheckpoint;
    const payload = decryptCheckpointPayload(stored, apiKey);
    return {
      version: stored.version,
      requestHash: stored.requestHash,
      ...payload,
    };
  } catch (error) {
    const detail = safeError(error, apiKey).message;
    throw new LangSmithApiError(
      `cannot read LangSmith checkpoint ${path}; restore the original LANGSMITH_API_KEY or remove the checkpoint (${detail})`,
    );
  }
}

function writeCheckpoint(path: string, checkpoint: Checkpoint, apiKey: string): void {
  const temporary = `${path}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // Native run payloads are encrypted so they remain byte-for-byte faithful on resume while
    // neither the active credential nor plaintext trace data is persisted in the checkpoint.
    const encrypted = encryptCheckpointPayload(
      { cursor: checkpoint.cursor, complete: checkpoint.complete, runs: checkpoint.runs },
      checkpoint.requestHash,
      apiKey,
    );
    const stored: StoredCheckpoint = {
      version: checkpoint.version,
      requestHash: checkpoint.requestHash,
      ...encrypted,
    };
    const serialized = JSON.stringify(stored);
    writeFileSync(temporary, `${serialized}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (error) {
    throw safeError(error, apiKey);
  }
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }
  return Math.min(1000 * 2 ** attempt, 30_000);
}

async function responseError(response: Response, apiKey: string): Promise<LangSmithApiError> {
  let body = "";
  try {
    body = await response.text();
  } catch {
    body = "<unreadable response body>";
  }
  const detail = redactLangSmithSecret(body.trim(), apiKey).slice(0, 2000);
  return new LangSmithApiError(
    redactLangSmithSecret(`LangSmith API ${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`, apiKey),
  );
}

async function requestJson(
  url: string,
  init: RequestInit,
  apiKey: string,
  request: typeof globalThis.fetch,
  sleep: (milliseconds: number) => Promise<void>,
  maxRateLimitRetries: number,
): Promise<unknown> {
  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      response = await request(url, { ...init, redirect: "error" });
    } catch (error) {
      throw safeError(error, apiKey);
    }
    if (response.status === 429 && attempt < maxRateLimitRetries) {
      await sleep(retryDelay(response, attempt));
      continue;
    }
    if (!response.ok) throw await responseError(response, apiKey);
    try {
      return await response.json();
    } catch (error) {
      throw safeError(error, apiKey);
    }
  }
}

function apiHeaders(apiKey: string, workspaceId: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-api-key": apiKey,
  };
  if (workspaceId) headers["x-tenant-id"] = workspaceId;
  return headers;
}

function projectIdFromResponse(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const first = value[0];
  if (typeof first !== "object" || first === null || Array.isArray(first)) return undefined;
  const id = (first as Record<string, unknown>)["id"];
  return typeof id === "string" ? id : undefined;
}

function runsPage(value: unknown): RunsPage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LangSmithApiError("LangSmith runs query returned an invalid response");
  }
  const page = value as Partial<RunsPage>;
  if (!Array.isArray(page.runs)) {
    throw new LangSmithApiError("LangSmith runs query response is missing 'runs'");
  }
  return page as RunsPage;
}

function langSmithRunId(run: unknown): string | undefined {
  if (typeof run !== "object" || run === null || Array.isArray(run)) return undefined;
  const object = run as Record<string, unknown>;
  const id = object["id"] ?? object["run_id"];
  return typeof id === "string" ? id : undefined;
}

/**
 * Fetch every native run in a LangSmith project and pass the accumulated objects to the same
 * parser used by file mode. A page and its next cursor are checkpointed atomically before the
 * following request, so interruption resumes without re-emitting earlier pages.
 */
export async function fetchLangSmithProject(
  project: string,
  options: LangSmithFetchOptions = {},
): Promise<LangSmithFetchResult> {
  const apiKey = process.env["LANGSMITH_API_KEY"] ?? "";
  if (!apiKey) {
    throw new LangSmithApiError(
      "LANGSMITH_API_KEY is required for --from langsmith-api; set it in the environment and retry",
    );
  }

  try {
    const baseUrl = normalizedBaseUrl(
      process.env["LANGSMITH_ENDPOINT"] ?? DEFAULT_BASE_URL,
      apiKey,
    );
    const workspaceId = process.env["LANGSMITH_WORKSPACE_ID"];
    const root = options.checkpointRoot ?? process.cwd();
    const request = options.request ?? globalThis.fetch;
    const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    const maxRateLimitRetries = options.maxRateLimitRetries ?? 5;
    const requestDescription = JSON.stringify({ baseUrl, project, workspaceId });
    const hash = requestHash(requestDescription);
    const path = checkpointPath(root, hash);
    const checkpoint = readCheckpoint(path, hash, apiKey);
    if (checkpoint.complete) {
      return { records: parseLangSmithRuns(checkpoint.runs), checkpointPath: path };
    }
    const headers = apiHeaders(apiKey, workspaceId);

    const sessionsUrl = new URL(endpoint(baseUrl, "/api/v1/sessions"));
    sessionsUrl.searchParams.set("name", project);
    const sessions = await requestJson(
      sessionsUrl.href,
      { method: "GET", headers },
      apiKey,
      request,
      sleep,
      maxRateLimitRetries,
    );
    const projectId = projectIdFromResponse(sessions);
    if (!projectId) throw new LangSmithApiError(`LangSmith project '${project}' was not found`);

    const seen = new Set<string>();
    for (const run of checkpoint.runs) {
      const id = langSmithRunId(run);
      if (id !== undefined) seen.add(id);
    }

    let cursor = checkpoint.cursor;
    do {
      const body: Record<string, unknown> = { session: [projectId], limit: PAGE_LIMIT, order: "asc" };
      if (cursor) body["cursor"] = cursor;

      const value = await requestJson(
        endpoint(baseUrl, "/api/v1/runs/query"),
        { method: "POST", headers, body: JSON.stringify(body) },
        apiKey,
        request,
        sleep,
        maxRateLimitRetries,
      );
      const page = runsPage(value);
      const nextCursor = page.runs.length === 0 ? null : (page.cursors?.next ?? null);
      if (
        containsLangSmithSecret(page.runs, apiKey) ||
        (nextCursor !== null && containsLangSmithSecret(nextCursor, apiKey))
      ) {
        throw new LangSmithApiError(
          "LangSmith returned the active API credential in run data or a pagination cursor; refusing to persist that page",
        );
      }
      for (const run of page.runs) {
        const id = langSmithRunId(run);
        if (id !== undefined && seen.has(id)) continue;
        if (id !== undefined) seen.add(id);
        checkpoint.runs.push(run);
      }
      if (nextCursor !== null && nextCursor === cursor) {
        throw new LangSmithApiError("LangSmith runs query repeated its pagination cursor");
      }
      cursor = nextCursor;
      checkpoint.cursor = cursor;
      checkpoint.complete = cursor === null;
      writeCheckpoint(path, checkpoint, apiKey);
    } while (cursor !== null);

    return { records: parseLangSmithRuns(checkpoint.runs), checkpointPath: path };
  } catch (error) {
    throw safeError(error, apiKey);
  }
}

/** Remove a completed pull's native-data checkpoint after the sanitized bundle is durable. */
export function clearLangSmithCheckpoint(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}
