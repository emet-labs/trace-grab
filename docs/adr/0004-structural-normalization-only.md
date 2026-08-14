# ADR-0004 · The CLI normalizes structure and never models semantics

**Status:** Decided.

## Context

LangSmith runs, Braintrust logs, OTLP spans, and hand-rolled JSONL have different shapes. Either
the CLI normalizes them into one schema, or it redacts each vendor shape in place.

Redacting in place preserves full fidelity and lets us iterate server-side forever — but the
redaction policy must then understand four schemas deeply, quadrupling the surface on which it
can be *wrong*, where wrong means a partner's customer's email address in our bucket.

## Decision

**One neutral, line-delimited JSON corpus, structurally normalized, semantically untouched.**

1. **Structural normalization only.** Every source maps to one record shape: id, parent id,
   name, kind, start, end, status, error, inputs, outputs, attributes, links, labels. One schema,
   one redaction engine, one thing to audit.
2. **No semantic modelling in the CLI.** It must not perform the requested/completed Event split
   (sentinel ADR-0015), derive causal edge classes, or apply observation-time rules.
   `sentinel/ingest/sagashop.rs` does that today and it is Sentinel's domain model, versioned by
   Sentinel's ADRs. Baking ADR-0015 into a partner's laptop ships the domain model somewhere it
   cannot be revised.
3. **An `unmapped` bag** carries source fields the normalizer did not recognize, subject to the
   *same* policy as everything else. Fidelity without a second redaction code path, and graceful
   degradation when a vendor adds a field next quarter.
4. **Source ids are retained** (tokenized, consistently) so a findings package can say "traces
   `TOK_4f1a` and `TOK_88b0` look like bugs" and the partner can actually find them.

## Alternatives rejected

- **Vendor passthrough with in-place redaction.** Four redaction code paths; four times the
  surface for the failure that ends the program.
- **Parquet**, despite LangSmith exporting it. Binary defeats "open it and look at it", and the
  volumes here are 10⁵ events, not 10⁸.
- **Canonical protobuf Events** per sentinel ADR-0024. Drags the canonical model onto partner
  machines and turns every model revision into a partner re-export.
- **OTLP JSON as the wire format.** A real standard with real tooling, and the campaign leans on
  OTel GenAI conventions. Rejected because it forces a lossy conversion of LangSmith and Braintrust
  records on the *partner's* machine, and sentinel ADR-0002 already establishes OTel as an adapter
  rather than the substrate. Revisit if the corpus is ever shared beyond Emet.

## Consequence

The corpus is an **untrusted input** to Sentinel, adapted by `ingest` exactly as
`capture-envelope-v1` is today. That is the house pattern; nothing new is required to receive it.
