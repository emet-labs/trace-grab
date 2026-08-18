import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const TRACE_GRAB_DIR = ".trace-grab";
const SALT_RELATIVE_PATH = ".trace-grab/salt";
const SALT_BYTES = 32;

/**
 * The salt file's location for a given root, honouring an explicit override (ADR-0006).
 * When `saltFile` is supplied it is used verbatim — `--salt-file` may point anywhere — otherwise
 * the default `.trace-grab/salt` under `root` applies.
 */
function saltPath(root: string, saltFile?: string): string {
  return saltFile ?? join(root, SALT_RELATIVE_PATH);
}

/** Outcome of {@link loadOrCreateSaltWithMeta}: the salt plus whether it had to be minted. */
export interface SaltResult {
  /** The 32-byte partner salt. */
  salt: Buffer;
  /** `true` when no salt existed and one was just generated; `false` when an existing salt was read. */
  created: boolean;
  /** Resolved path the salt was read from or written to. */
  path: string;
}

/**
 * Persistent per-partner salt (ADR-0006). Generated once, 32 random bytes, mode 0600. Never
 * leaves the partner's machine and never enters the bundle.
 *
 * Reports whether the salt was newly created so the CLI can print the first-run notice exactly
 * once. Use {@link loadOrCreateSalt} when the created/loaded distinction is not needed.
 */
export function loadOrCreateSaltWithMeta(
  root: string = process.cwd(),
  saltFile?: string,
): SaltResult {
  const path = saltPath(root, saltFile);
  if (existsSync(path)) {
    return { salt: readFileSync(path), created: false, path };
  }

  const salt = randomBytes(SALT_BYTES);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, salt, { mode: 0o600 });
  return { salt, created: true, path };
}

/**
 * Persistent per-partner salt (ADR-0006). Generated once, 32 random bytes, mode 0600. Never
 * leaves the partner's machine and never enters the bundle. Backward-compatible buffer return;
 * see {@link loadOrCreateSaltWithMeta} when the created/loaded signal is needed.
 */
export function loadOrCreateSalt(root: string = process.cwd(), saltFile?: string): Buffer {
  return loadOrCreateSaltWithMeta(root, saltFile).salt;
}

/**
 * Read the existing partner salt without minting one (ADR-0006). Used by `check`, which
 * must fail loudly when no salt exists rather than silently creating a fresh one and
 * reporting false negatives (the corpus was built under a different, now-absent salt).
 */
export function loadSalt(root: string = process.cwd(), saltFile?: string): Buffer {
  const path = saltPath(root, saltFile);
  if (!existsSync(path)) {
    throw new Error(`No salt found at ${path}. Run 'trace-grab grab' in this directory first.`);
  }
  return readFileSync(path);
}

/** `.gitignore` body for the `.trace-grab/` directory — ignores every local secret (ADR-0006). */
const GITIGNORE_BODY = "# trace-grab local secrets — never commit (ADR-0006)\n*\n!.gitignore\n";

/**
 * Write/refresh a `.gitignore` inside `.trace-grab/` so the salt and keymap are never committed
 * (ADR-0006). Idempotent — safe to call on every run. When `--salt-file` points outside the
 * default directory this still guards the default `.trace-grab/` location for the keymap.
 */
export function writeTraceGrabGitignore(root: string = process.cwd()): void {
  const dir = join(root, TRACE_GRAB_DIR);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, ".gitignore");
  writeFileSync(path, GITIGNORE_BODY);
  // The .gitignore itself carries no secret; reset to a plain rw-r--r-- in case an earlier,
  // stricter mode was inherited.
  chmodSync(path, 0o644);
}
