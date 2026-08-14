# ADR-0006 · Persistent salt plus a local keymap

**Status:** Decided. Refines [ADR-0005](0005-deny-by-default-equality-preserving-tokenization.md).

## Context

Deny-by-default only works if the partner can still **read the findings package**. The campaign's
own example deliverable says "3 traces your team considered bugs" — worthless if `TOK_19c2`
cannot be turned back into a real account. The reverse direction has to exist somewhere, and
where it lives is a governance decision.

## Forced mechanics

- **HMAC-SHA256 with a secret salt**, truncated. Not a plain hash: `sha256("alice@corp.com")` is
  reversed by anyone with a wordlist, which would make the whole scheme decorative.
- **Tokens are scoped to the value globally within a corpus, never per path.** `order.id` in one
  span and `orderId` in another must produce the same token, or the cross-system relational
  structure of sentinel ADR-0016 is destroyed silently.
- **The salt never leaves the partner's machine and never enters the bundle.** Without it we
  cannot invert a token even for a value we can guess. This is what makes "we cannot read your
  data" true rather than aspirational.

## Decision

**Persistent salt, plus a local reverse keymap**, with an opt-out.

- `.trace-grab/salt` — 32 random bytes, mode `0600`, generated on first run.
- `.trace-grab/keymap.jsonl` — token → original value, mode `0600`, gitignored by the tool,
  never uploaded, suppressible with `--no-keymap`.

## Rationale

The keymap contains nothing the partner does not already have: it is derived entirely from their
own data and lives entirely in their own environment. The only new risk is a second copy of
sensitive values on one machine — real, but modest next to the alternative, which is that the
findings package is unreadable and the entire value exchange collapses.

## Alternatives rejected

- **Ephemeral salt, discarded per run.** Maximum safety; nobody can ever invert, including the
  partner. Findings become unreadable and Tier 2 cross-batch correlation is impossible because
  the same account gets a different token every month. Effectively caps the program at Tier 1.
- **Persistent salt, no keymap** (the `--no-keymap` fallback). Supports "I suspect this value —
  is it this token?" but not "what *is* this token?", which is the direction someone reading a
  report actually needs.

## Consequences

- The tool must be **loud** about the keymap existing and what is in it — in the report and the
  README.
- The salt has a **lifecycle that is documented workflow, not an accident**.

> [!WARNING]
> Losing the salt between batch one and batch two produces a corpus that looks perfectly fine,
> passes every test, and correlates with nothing. There is no error to observe — which is exactly
> why the lifecycle has to be documented rather than assumed.
- The per-corpus time shift ([ADR-0009](0009-four-disposition-policy-language.md)) derives from
  the same salt, so it too is stable across batches.
