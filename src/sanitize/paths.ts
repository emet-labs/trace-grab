/**
 * The dotted-path language shared by the policy, the inventory, and the report (ADR-0009).
 *
 * A path is a dot-separated sequence of segments. Two wildcards:
 *   - `*`  matches exactly one segment.
 *   - `**` matches any number of segments, including zero.
 *
 * Array elements collapse to a `[*]` suffix on their parent segment — `inputs.items[*].sku` —
 * so every element of an array shares one path and the inventory stays bounded regardless of
 * array length. The `[*]` is ordinary literal text within its segment; the matcher treats it as
 * such, which preserves the distinction between an object key and an array element at the same
 * name (`inputs.items.sku` ≠ `inputs.items[*].sku`).
 *
 * Matching is a hand-rolled segment walk, never a regex compiled from user input. Policy text is
 * an attacker-adjacent config surface, and `new RegExp(pattern)` is the classic ReDoS vector this
 * language must not open.
 */

const WILDCARD_ONE = "*";
const WILDCARD_ANY = "**";

/** Split a dotted path into segments. The dot is the sole separator; `[*]` stays part of its segment. */
export function splitPath(path: string): string[] {
  return path.split(".");
}

/** Number of literal (non-wildcard) segments in `pattern`. */
export function literalSegmentCount(pattern: string): number {
  let count = 0;
  for (const segment of splitPath(pattern)) {
    if (segment !== WILDCARD_ONE && segment !== WILDCARD_ANY) count += 1;
  }
  return count;
}

/** Total number of segments in `pattern`. */
export function segmentCount(pattern: string): number {
  return splitPath(pattern).length;
}

/**
 * Does `pattern` match the concrete `path`, segment-wise?
 *
 * `*` matches exactly one segment; `**` matches any run of segments including the empty run.
 */
export function matchPath(pattern: string, path: string): boolean {
  return matchSegments(splitPath(pattern), splitPath(path));
}

function matchSegments(pattern: string[], path: string[]): boolean {
  // Memoized over (pattern index, path index) so a pattern with many `**` stays O(m·n), never
  // exponential. This is the "no regex" safety net for pathological wildcard runs.
  const memo = new Map<number, boolean>();

  const go = (pi: number, si: number): boolean => {
    const key = pi * (path.length + 1) + si;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    let result: boolean;
    if (pi === pattern.length) {
      result = si === path.length;
    } else if (pattern[pi] === WILDCARD_ANY) {
      result = false;
      for (let skip = si; skip <= path.length && !result; skip++) {
        result = go(pi + 1, skip);
      }
    } else if (si >= path.length) {
      result = false;
    } else if (pattern[pi] === WILDCARD_ONE || pattern[pi] === path[si]) {
      result = go(pi + 1, si + 1);
    } else {
      result = false;
    }

    memo.set(key, result);
    return result;
  };

  return go(0, 0);
}

/**
 * Specificity order for ADR-0009's precedence rule ("most-specific path wins").
 *
 * A pattern is more specific when it has more literal segments; on a tie, fewer total segments
 * (fewer wildcards) is more specific — `inputs` beats `inputs.**` for the path `inputs`, because
 * the exact match constrains more than the wildcard-suffixed one.
 *
 * Returns <0 when `a` is more specific than `b`, >0 when `b` is more specific, and 0 on a tie.
 */
export function compareSpecificity(a: string, b: string): number {
  const literalDiff = literalSegmentCount(b) - literalSegmentCount(a);
  if (literalDiff !== 0) return literalDiff;
  return segmentCount(a) - segmentCount(b);
}
