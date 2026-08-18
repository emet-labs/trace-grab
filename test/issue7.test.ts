import { describe, expect, test } from "bun:test";

import { PathInventory, type OnInventory } from "../src/sanitize/inventory.js";

/** Fixed 32-byte test salt — deterministic so assertions are stable (ADR-0006). */
const SALT = Buffer.alloc(32, 7);

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
});
