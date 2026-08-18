import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** One line of the reverse keymap: a token and the original value it stands for. */
export interface KeymapEntry {
  token: string;
  value: string;
}

/**
 * Append-only local reverse keymap: token → original value (ADR-0006). JSONL, mode 0600,
 * never uploaded, suppressible with `--no-keymap`.
 *
 * A token deterministically maps to exactly one value for a given salt, so dedup is keyed on the
 * token alone: a token already recorded is never re-written. Pairs are buffered during a `grab`
 * run and flushed once at the end, so a run produces at most one write and the file stays a clean
 * JSONL stream whether it pre-existed or not.
 */
export class Keymap {
  private readonly path: string;
  private readonly existing: Set<string>;
  private readonly pending: Map<string, string> = new Map();

  private constructor(path: string, existing: Set<string>) {
    this.path = path;
    this.existing = existing;
  }

  /**
   * Open the keymap at `path`. If it already exists, every token already recorded is read into an
   * in-memory set so subsequent {@link add} calls skip it. Malformed lines are skipped — a corrupt
   * keymap line must never crash a grab.
   */
  static open(path: string): Keymap {
    const existing = new Set<string>();
    if (existsSync(path)) {
      // Re-assert 0600 in case an external process or prior bug loosened the mode — the keymap
      // holds plaintext values, so its permissions must never drift (ADR-0006).
      chmodSync(path, 0o600);
      for (const line of readFileSync(path, "utf8").split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          const entry = JSON.parse(trimmed) as Partial<KeymapEntry>;
          if (typeof entry.token === "string") existing.add(entry.token);
        } catch {
          // Skip malformed lines — never crash a grab over a corrupt keymap.
        }
      }
    }
    return new Keymap(path, existing);
  }

  /**
   * Buffer a token → value pair (called from the sanitize walk via the `onToken` callback).
   * Idempotent per token: a token already on disk or already buffered is not recorded again.
   */
  add(token: string, value: string): void {
    if (this.existing.has(token) || this.pending.has(token)) return;
    this.pending.set(token, value);
  }

  /** The `onToken` callback to thread into {@link sanitizeRecord}. */
  callback(): (token: string, value: string) => void {
    return (token, value) => this.add(token, value);
  }

  /**
   * Flush every buffered pair to disk as JSONL, mode 0600. No-op when nothing is pending, so a
   * re-run over the same corpus leaves an idempotent keymap untouched. Creates the parent
   * directory and the file (0600) on first write; appends and re-asserts 0600 thereafter.
   */
  flush(): void {
    if (this.pending.size === 0) return;
    const lines: string[] = [];
    for (const [token, value] of this.pending) {
      lines.push(JSON.stringify({ token, value } satisfies KeymapEntry));
    }
    const block = lines.join("\n") + "\n";
    mkdirSync(dirname(this.path), { recursive: true });
    if (existsSync(this.path)) {
      appendFileSync(this.path, block);
      chmodSync(this.path, 0o600);
    } else {
      writeFileSync(this.path, block, { mode: 0o600 });
    }
    this.pending.clear();
  }
}
