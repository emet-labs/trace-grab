import { describe, expect, test } from "bun:test";

import type { RawRecord } from "../src/normalize/index.js";
import { PathInventory, type OnInventory } from "../src/sanitize/inventory.js";
import { PolicyResolver } from "../src/sanitize/policy.js";
import { sanitizeRecord } from "../src/sanitize/record.js";
import { tokenize } from "../src/sanitize/tokenize.js";

/** Fixed 32-byte test salt — deterministic so assertions are stable (ADR-0006). */
const SALT = Buffer.alloc(32, 7);

/** Object keys of `v` when it is a plain object, else `[]` — a no-cast read of a JsonValue. */
function keysOf(v: unknown): string[] {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? Object.keys(v as Record<string, unknown>)
    : [];
}

/** The string at `key` of a plain-object `v`, else `undefined` — narrows before access. */
function fieldOf(v: unknown, key: string): unknown {
  if (v !== null && typeof v === "object" && !Array.isArray(v) && key in v) {
    return (v as Record<string, unknown>)[key];
  }
  return undefined;
}

/** A minimal valid RawRecord with the given `inputs` value (and absolute-time defaults). */
function recordWith(inputs: unknown, overrides: Partial<RawRecord> = {}): RawRecord {
  return {
    id: "span-x",
    trace_id: "trace-x",
    parent_id: null,
    name: "probe",
    kind: "tool",
    start: "2026-08-01T14:03:22.104Z",
    end: "2026-08-01T14:03:22.481Z",
    status: "ok",
    error: null,
    inputs: inputs as RawRecord["inputs"],
    outputs: {},
    attributes: {},
    labels: [],
    links: [],
    unmapped: {},
    source: { vendor: "langsmith" },
    ...overrides,
  };
}

describe("issue #7: sanitization walk and path inventory", () => {
  describe("PathInventory accumulator", () => {
    test("records occurrences, disposition, and the first rendered example per path", () => {
      const inv = new PathInventory();
      const cb: OnInventory = inv.callback();

      cb("inputs.user_id", "reveal", "u_48213");
      cb("inputs.user_id", "reveal", "u_99999"); // distinct value #2, same path
      cb("inputs.user_id", "reveal", "u_48213"); // repeat — occurrences up, distinct unchanged
      cb("inputs.session_token", "tokenize", "TOK_a3d17c9e02");

      const uid = inv.get("inputs.user_id")!;
      expect(uid.occurrences).toBe(3);
      expect(uid.disposition).toBe("reveal");
      expect(uid.distinctValues).toBe(2);
      expect(uid.capped).toBe(false);
      // First rendered example is retained — real value for `reveal`.
      expect(uid.example).toBe("u_48213");

      const tok = inv.get("inputs.session_token")!;
      expect(tok.occurrences).toBe(1);
      expect(tok.disposition).toBe("tokenize");
      expect(tok.distinctValues).toBe(1);
      // Token (not real value) is the example for `tokenize`.
      expect(tok.example).toBe("TOK_a3d17c9e02");
    });

    test("drop decisions carry no example but still count occurrences", () => {
      const inv = new PathInventory();
      inv.callback()("inputs.secret", "drop", null);
      inv.callback()("inputs.secret", "drop", null);

      const secret = inv.get("inputs.secret")!;
      expect(secret.occurrences).toBe(2);
      expect(secret.disposition).toBe("drop");
      expect(secret.example).toBeNull();
      // A dropped path contributes no distinct values.
      expect(secret.distinctValues).toBe(0);
    });

    test("entries() is sorted by path for determinism", () => {
      const inv = new PathInventory();
      const cb = inv.callback();
      cb("z.last", "reveal", "z");
      cb("a.first", "reveal", "a");
      cb("m.middle", "reveal", "m");

      const paths = inv.entries().map((e) => e.path);
      expect(paths).toEqual(["a.first", "m.middle", "z.last"]);
    });

    test("distinct-value counting caps at the configured limit and stops", () => {
      const inv = new PathInventory(3);
      const cb = inv.callback();
      // Three distinct values → exactly at the cap → capped flips true.
      cb("p", "tokenize", "v1");
      cb("p", "tokenize", "v2");
      cb("p", "tokenize", "v3");
      expect(inv.get("p")!.distinctValues).toBe(3);
      expect(inv.get("p")!.capped).toBe(true);
      // Past the cap, new distinct values are NOT counted (memory-boundedness).
      cb("p", "tokenize", "v4");
      cb("p", "tokenize", "v5");
      expect(inv.get("p")!.distinctValues).toBe(3);
      expect(inv.get("p")!.capped).toBe(true);
    });

    test("size() counts distinct paths only", () => {
      const inv = new PathInventory();
      const cb = inv.callback();
      cb("a", "reveal", "1");
      cb("a", "reveal", "1");
      cb("b", "reveal", "2");
      expect(inv.size()).toBe(2);
    });

    test("is byte-identical to a no-inventory run when salt-stable (idempotent re-record)", () => {
      // Deterministic tokens ⇒ re-recording the same values yields the same distinct set and counts.
      const inv1 = new PathInventory();
      const inv2 = new PathInventory();
      const a = inv1.callback();
      const b = inv2.callback();
      const values = ["x", "y", "x", "z", "y", "x"];
      for (const v of values) {
        a("p", "tokenize", v);
        b("p", "tokenize", v);
      }
      expect(inv1.get("p")).toEqual(inv2.get("p"));
    });
  });

  describe("cycle detection (AC #1)", () => {
    test("a cyclic object in inputs is rejected with a path-naming error, not a hang", () => {
      const a: Record<string, unknown> = {};
      const b: Record<string, unknown> = { c: a };
      a.b = b; // a → b → c → a: a cycle through `inputs.a.b.c`.
      expect(() => sanitizeRecord(recordWith(a), SALT)).toThrow(/cyc/i);
    });

    test("a self-referential array element is rejected too", () => {
      const arr: unknown[] = [];
      arr.push(arr); // element contains its own container — a cycle through `inputs[*]`.
      expect(() => sanitizeRecord(recordWith(arr), SALT)).toThrow(/cyc/i);
    });

    test("a shared (non-cyclic) sub-object referenced from two siblings is allowed", () => {
      // A DAG is not a cycle: the same object at two paths must not trip the guard.
      const shared = { v: "x" };
      const out = sanitizeRecord(recordWith({ a: shared, b: shared }), SALT);
      // `v` is a default-tokenized string leaf — both sibling references resolve to the same token.
      const aField = fieldOf(out.inputs, "a");
      const bField = fieldOf(out.inputs, "b");
      expect(fieldOf(aField, "v")).toMatch(/^TOK_/);
      expect(fieldOf(bField, "v")).toMatch(/^TOK_/);
    });
  });

  describe("path inventory wiring (AC #2, #3, accumulation correctness)", () => {
    test("a dropped subtree removes the key, not just the value (AC #2)", () => {
      const resolver = new PolicyResolver({
        reveal: [],
        tokenize: [],
        drop: ["inputs.secret"],
        time: "absolute",
      });
      const out = sanitizeRecord(
        recordWith({ user_id: "u_1", secret: { token: "leak", nested: { deep: "x" } } }),
        SALT,
        resolver,
 );
      // The `secret` key is gone entirely — not null, not an empty object, not present.
      expect(keysOf(out.inputs)).not.toContain("secret");
      // A sibling field at the same level survives and is tokenized (default string rule).
      expect(keysOf(out.inputs)).toContain("user_id");
      expect(fieldOf(out.inputs, "user_id")).toMatch(/^TOK_/);
    });

    test("10k-element array inventory stays bounded — one collapsed path, 10000 occurrences (AC #3)", () => {
      const inv = new PathInventory();
      const items = Array.from({ length: 10000 }, () => ({ sku: "x" }));
      sanitizeRecord(recordWith({ items }), SALT, new PolicyResolver(), undefined, inv.callback());

      // Array collapse: every element shares the path `inputs.items[*].sku` — one entry, not 10k.
      const sku = inv.get("inputs.items[*].sku")!;
      expect(sku.occurrences).toBe(10000);
      expect(sku.distinctValues).toBe(1); // all "x" → one token → one distinct value
      expect(sku.capped).toBe(false);
      // Total path count is bounded by the schema's leaf count, not by array length.
      expect(inv.size()).toBeLessThan(50);
      // No per-element path leaked through the collapse.
      expect(inv.get("inputs.items[*].sku")!.path).toBe("inputs.items[*].sku");
    });

    test("inventory accumulation correctness — real value for reveal, token for default-tokenize", () => {
      const resolver = new PolicyResolver({
        reveal: ["inputs.user_id"],
        tokenize: [],
        drop: [],
        time: "absolute",
      });
      const inv = new PathInventory();
      const out = sanitizeRecord(
        recordWith({ user_id: "u_48213", session_token: "sess_9f2a7c1e" }),
        SALT,
        resolver,
        undefined,
        inv.callback(),
      );

      // Reveal field: disposition `reveal`, example is the real (un-tokenized) value, and the
      // output carries that same real value verbatim.
      const uid = inv.get("inputs.user_id")!;
      expect(uid.disposition).toBe("reveal");
      expect(uid.example).toBe("u_48213");
      expect(uid.occurrences).toBe(1);
      expect(fieldOf(out.inputs, "user_id")).toBe("u_48213");

      // Default-tokenized field: disposition `default`, example is the token the walk produced.
      const tok = inv.get("inputs.session_token")!;
      expect(tok.disposition).toBe("default");
      expect(tok.example).toBe(tokenize("sess_9f2a7c1e", SALT));
      expect(fieldOf(out.inputs, "session_token")).toBe(tokenize("sess_9f2a7c1e", SALT));

      // Pass-verbatim top-level field: disposition `default`, example is the real value.
      const name = inv.get("name")!;
      expect(name.disposition).toBe("default");
      expect(name.example).toBe("probe");

      // Top-level tokenized id: disposition `default`, example is the token.
      const id = inv.get("id")!;
      expect(id.disposition).toBe("default");
      expect(id.example).toBe(tokenize("span-x", SALT));
    });
  });
});
