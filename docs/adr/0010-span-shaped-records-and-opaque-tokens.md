# ADR-0010 · Span-shaped records, nested attributes, opaque tokens

**Status:** Decided. Defines `trace-corpus-v1`, normatively specified in `docs/SCHEMA.md`.

## Context

This is the data contract — the thing every partner and every findings package is stuck with, and
the thing `sentinel/ingest` writes an adapter against.

## Decisions

### Span-shaped, not event-shaped

One record = one source unit of work, with `start`, `end`, `status`, `parent_id`. Sentinel
ADR-0015 makes Events points on transitions and `ingest/sagashop.rs` splits each span into
`requested` / `completed` — but that split is Sentinel semantics and belongs on Sentinel's side of
the boundary, per [ADR-0004](0004-structural-normalization-only.md). The CLI emits what the vendor
gave it, structurally normalized.

### Causality is copied, never derived

`parent_id` plus optional `links[]`, and nothing else. LangSmith gives a parent run; OTLP gives a
parent span and links. Anything beyond faithfully copying those is derivation, and derivation is
Sentinel's.

**Dangling parents are preserved.** `ingest/capture.rs` already documents that an unresolved
parent is *evidence about missing evidence*, and sentinel ADR-0019 names missing parents as a case
the tracer bullet must handle rather than refuse. The CLI must not "fix" it; the manifest counts
it.

### Nested attributes preserved; dotted paths are the query language

LangSmith `inputs` / `outputs` are arbitrary nested JSON. They are simultaneously the highest-value
data for runtime verification — argument identity is where `modify_account(x)` requires
`authenticate(x)` lives — and the highest PII risk. The nesting stays in the record, because
flattening loses type and array structure that cannot be rebuilt. The **policy, inventory, and
report** speak dotted paths over that structure
([ADR-0009](0009-four-disposition-policy-language.md)).

### Tokens are opaque: `TOK_<10 hex>`

The campaign doc's `USER_a8f3` / `ACCOUNT_19c2` style is more readable, but a type hint must be
derived from *some* key the value appeared under, and the same value legitimately appears under
different keys. That either breaks global value-scoping — fatal, per
[ADR-0006](0006-persistent-salt-and-local-keymap.md) — or makes the prefix depend on iteration
order, so tokens drift between batches. Since the keymap already solves readability locally, the
stable opaque token wins.

### The manifest carries what does not belong on every line

`schema_version`, generator name and version, `generated_at`, source vendor, counts (traces,
records, distinct paths, distinct tokens, dangling parents, excluded traces), the policy hash, the
corpus SHA-256, the partner-supplied label, and the warning list.

## Consequence

`sentinel/ingest` gains a `trace-corpus-v1` adapter alongside the SagaShop one, sitting behind the
same untrusted-input boundary. Corpus records are not Events until Sentinel makes them Events.
