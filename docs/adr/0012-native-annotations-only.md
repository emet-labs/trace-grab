# ADR-0012 · Labels ride along natively; no sidecar in v1

**Status:** Decided.

## Context

The campaign's data-strategy table says the unique thing partners provide is **semantic ground
truth** — "what observed regularities actually mean" — and calls it the label synthetic data
cannot give. The minimum-dataset list includes "success / failure / human intervention". Status is
in the data. **"Human intervention" is not**: it is a judgment a human at the company holds, and
no telemetry emits it.

## Decision

**Pass through native annotations only.** LangSmith feedback scores and annotation queues,
Braintrust annotated exports, and equivalent vendor fields map onto the record's `labels` block.
Purely structural — the CLI copies, it does not judge, consistent with
[ADR-0004](0004-structural-normalization-only.md).

Free signal for teams that already annotate; nothing for teams that do not.

**Semantic ground truth therefore comes from Tier 2 conversations**, not from the collection tool.

## Alternative deferred, not rejected

**A sidecar join** — the partner supplies `labels.csv` (their trace id, a label, an optional note),
joined on the *pre-sanitization* id and then tokenized like everything else. Roughly thirty lines,
no expression language, works identically across every source including custom logs, and matches
how teams actually hold this knowledge: a spreadsheet or a Jira export, not their tracing tool.

Deferred for v1. The join point is defined by this ADR, so adding it later is cheap. If it is
added, two constraints bind:

- Unmatched label rows must warn loudly — same failure class as the unmatched-policy-path warning
  in [ADR-0009](0009-four-disposition-policy-language.md).
- Free-text notes default to tokenized, with `reveal: labels.note` as the opt-in, or the
  ground-truth channel quietly becomes the largest PII hole in the design.

## Risk to watch

"We will add the sidecar later" must not become the reason nobody ever asks partners for labels.
Labels are the campaign's stated ultimate output; if Tier 2 conversations are the only channel,
that channel needs to be scheduled deliberately rather than assumed.
