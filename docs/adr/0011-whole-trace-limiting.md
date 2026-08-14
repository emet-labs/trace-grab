# ADR-0011 · Limiting is whole-trace, never per-span

**Status:** Decided.

## Context

Success metrics call for 100k+ events at three months. A mid-size company running production
agents can emit that in a day. "Send us six months of everything" is simultaneously far more than
needed, a much larger ask than necessary, and a bundle nobody wants to move.

The size of the ask is also a negotiation position: *one project, 2–4 weeks* gets a yes from
people who would refuse six months of everything.

## The trap

> [!CAUTION]
> Sampling by span is incorrect. A half-captured trace is not a small trace — it is a corrupt one.

**Sampling by span is incorrect.** Runtime verification operates over complete executions — a
half-captured trace is not a small trace, it is a corrupt one, and it surfaces as phantom
violations and missing-precedence noise in the findings package we hand back.

## Decision

- Flags are `--since`, `--until`, and `--max-traces`.
- **Limiting selects whole traces by root**, with every descendant included or the trace excluded
  entirely. Selection is deterministic — hash the root id, take a stable prefix — so it is
  reproducible with no reservoir state, and re-running with a larger limit yields a **superset** of
  the smaller one.
- The tool **never truncates a trace it selected.**
- Traces excluded by limiting, and records whose parent is unresolved **in the source**, are
  counted separately in the manifest and surfaced in the report. Those are different phenomena:
  the first is our doing, the second is evidence about the partner's telemetry and is preserved
  per [ADR-0010](0010-span-shaped-records-and-opaque-tokens.md).

## Program consequence

Outreach asks for **one project, 2–4 weeks, roughly 20–50k events**. Small enough to be a quick
yes, large enough to mine candidate properties against. If the findings package lands, we ask for
more — which makes the tier progression a data progression too, instead of front-loading the
entire ask into the coldest conversation.

## Alternative rejected

**Ask wide.** A narrow window may miss the rare failure modes that make a findings package
impressive, and rare-event coverage is exactly what a runtime-verification pitch wants to show.
Rejected for v1: the first conversation is where the ask is hardest to get, and a second batch is
a much easier request than a first.
