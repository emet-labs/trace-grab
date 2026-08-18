import type { Disposition } from "./policy.js";

/**
 * Per-path inventory entry accumulated during the sanitization walk (issue #7).
 *
 * One entry per distinct dotted path visited across all records. Array elements collapse to a
 * single `[*]` path (see [paths.ts](./paths.ts)), so a 10k-element array produces ONE entry with
 * `occurrences = 10000` rather than 10k entries — the inventory is memory-bounded by the shape of
 * the schema, not the size of the corpus.
 */
export interface InventoryEntry {
  /** Dotted path, with `[*]` for collapsed array elements — the same language `paths.ts` speaks. */
  path: string;
  /** How many times this path was visited across all records (array collapse → one path, many visits). */
  occurrences: number;
  /** The resolved disposition at this path: `reveal` | `tokenize` | `drop` | `default`. */
  disposition: Disposition;
  /** Count of distinct rendered values seen at this path, bounded by the cap. */
  distinctValues: number;
  /** `true` once distinct values exceeded the cap; counting stops thereafter. */
  capped: boolean;
  /** One rendered example: the real value for `reveal`, the `TOK_…` token for `tokenize`, the stringified primitive for pass-through numbers/booleans. `null` for `drop` (the field is gone). */
  example: string | null;
}

/**
 * Side-channel the walk invokes at every leaf decision. Mirrors {@link OnToken}: the returned
 * `CorpusRecord` is byte-identical whether or not an inventory is attached, so the inventory is a
 * pure observer of decisions the walk already made (ADR-0002 — no corpus-wide passes).
 */
export type OnInventory = (
  path: string,
  disposition: Disposition,
  renderedExample: string | null,
) => void;

/** Default distinct-value cap per path — past this, distinct counting stops. */
const DEFAULT_CAP = 1000;

/**
 * Mutable per-path inventory accumulator. Threaded into {@link sanitizeRecord} as an optional
 * `onInventory` callback (the `OnToken` pattern). Dedup is keyed on the rendered example string:
 * equal values collide into equal tokens globally (ADR-0006), so re-sanitizing a record yields the
 * same distinct set — the inventory is idempotent in the same sense the keymap is.
 *
 * Distinct-value growth is bounded by the cap: once a path has seen `cap` distinct rendered
 * examples, `capped` flips to `true` and new distinct values stop being counted. This is the
 * memory-boundedness property that mirrors array collapse for high-cardinality paths.
 */
export class PathInventory {
  private readonly cap: number;
  private readonly byPath = new Map<string, InventoryEntry>();
  /** Per-path set of rendered examples seen — the dedup key for distinct-value counting. */
  private readonly distinctSets = new Map<string, Set<string>>();
  /** Paths that have hit the cap and stopped counting new distinct values. */
  private readonly cappedPaths = new Set<string>();

  constructor(cap: number = DEFAULT_CAP) {
    this.cap = cap;
  }

  /**
   * Record a leaf decision the walk made at `path`. Called from the walk at every surviving leaf
   * (and at every dropped path with `renderedExample === null`). Idempotent across re-sanitization
   * in the same sense the keymap is: deterministic tokens ⇒ the same values produce the same
   * rendered examples ⇒ the same distinct set.
   */
  record(path: string, disposition: Disposition, renderedExample: string | null): void {
    let entry = this.byPath.get(path);
    if (entry === undefined) {
      entry = {
        path,
        occurrences: 0,
        disposition,
        distinctValues: 0,
        capped: false,
        example: null,
      };
      this.byPath.set(path, entry);
      this.distinctSets.set(path, new Set());
    }
    entry.occurrences += 1;
    // The disposition resolved at a given path is deterministic across records; keep it current.
    entry.disposition = disposition;

    // `drop` decisions carry no rendered value — count the occurrence but not a distinct value.
    if (renderedExample === null) return;
    // Once capped, stop counting new distinct values (memory-boundedness for high-cardinality paths).
    if (this.cappedPaths.has(path)) return;

    const set = this.distinctSets.get(path)!;
    if (set.has(renderedExample)) return;
    set.add(renderedExample);
    entry.distinctValues = set.size;
    // Keep the first rendered example seen at this path — real value for `reveal`, token for `tokenize`.
    if (entry.example === null) entry.example = renderedExample;
    if (set.size >= this.cap) {
      entry.capped = true;
      this.cappedPaths.add(path);
    }
  }

  /** A sorted snapshot of every recorded path, for deterministic reporting. */
  entries(): InventoryEntry[] {
    return [...this.byPath.values()].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
  }

  /** The entry for a single path, if any. */
  get(path: string): InventoryEntry | undefined {
    return this.byPath.get(path);
  }

  /** Distinct path count — used by tests and (later) the manifest. */
  size(): number {
    return this.byPath.size;
  }

  /** The `onInventory` callback to thread into {@link sanitizeRecord}. */
  callback(): OnInventory {
    return (path, disposition, renderedExample) =>
      this.record(path, disposition, renderedExample);
  }
}
