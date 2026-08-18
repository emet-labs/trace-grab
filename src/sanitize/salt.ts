import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const SALT_RELATIVE_PATH = ".trace-grab/salt";
const SALT_BYTES = 32;

/**
 * Persistent per-partner salt (ADR-0006). Generated once, 32 random bytes, mode 0600. Never
 * leaves the partner's machine and never enters the bundle.
 */
export function loadOrCreateSalt(root: string = process.cwd()): Buffer {
  const path = join(root, SALT_RELATIVE_PATH);
  if (existsSync(path)) {
    return readFileSync(path);
  }

  const salt = randomBytes(SALT_BYTES);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, salt, { mode: 0o600 });
  return salt;
}

/**
 * Read the existing partner salt without minting one (ADR-0006). Used by `check`, which
 * must fail loudly when no salt exists rather than silently creating a fresh one and
 * reporting false negatives (the corpus was built under a different, now-absent salt).
 */
export function loadSalt(root: string = process.cwd()): Buffer {
  const path = join(root, SALT_RELATIVE_PATH);
  if (!existsSync(path)) {
    throw new Error(`No salt found at ${path}. Run 'trace-grab grab' in this directory first.`);
  }
  return readFileSync(path);
}
