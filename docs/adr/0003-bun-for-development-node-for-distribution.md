# ADR-0003 · Bun for development, Node for distribution

**Status:** Decided.

## Context

"Use Bun" answers two separable questions: what the team builds with, and what a partner must
have installed. The second one has a cost that lands at the worst moment in the funnel.

## Decision

- **Development:** Bun — package manager, `bun test`, TypeScript with no build step. Matches the
  house toolchain (`website/` already has a `bun.lock`).
- **Distribution:** plain **Node-compatible ESM**, published to npm, run as
  `npx @emet/trace-grab`. Works identically under `bunx` and `pnpm dlx`.
- **Enforcement:** Bun-only APIs (`Bun.file`, `Bun.write`, `Bun.serve`, `bun:sqlite`) are banned
  from `src/` and permitted in tests and scripts. CI runs the built package under Node 20 and 22.
- **Engine floor:** Node ≥ 20 — native `fetch`, `node:util.parseArgs`, stable ESM.

## Rationale

Picture the moment: a platform engineer has just agreed to hand over six months of traces, and
the first instruction is "install Bun." Node is already on their machine and on every corporate
approved-runtime list. The standard Bun install pipes a shell script from the internet into
bash — the exact gesture the security-conscious reviewer being courted will refuse. Spending a
warm partner's willingness on a runtime preference is the worst trade available.

## Alternatives rejected

- **Bun required end to end.** Its real advantage is that the `.ts` a reviewer reads is literally
  what executes. That is recovered at ~90% by shipping unbundled, unminified output plus the `.ts`
  sources in the tarball, at none of the install cost.
- **`bun build --compile` to a standalone binary.** Returns to the opaque-blob problem
  [ADR-0001](0001-contributor-side-only-and-open-source.md) exists to avoid; closing it would need
  reproducible builds and provenance for a binary, which is heavy machinery for five partners.
- **Rust, sharing `sentinel/model` types.** Type sharing across the corpus boundary is a false
  economy — the boundary is an untrusted-input boundary by design
  ([ADR-0004](0004-structural-normalization-only.md)).
- **Python via `uvx`.** Genuinely close: the ICP builds agents in Python. The tiebreak is that
  this is a one-off laptop CLI that never touches their runtime, so it need not match their stack,
  and Node has less environment ceremony than venv management.

## Packaging consequences

- `files` includes `dist/`, `src/`, and `docs/` — the sources ship.
- Exactly **one runtime dependency** (`yaml`).
- **No `postinstall` script, ever.** It is the first thing a reviewer greps for.
