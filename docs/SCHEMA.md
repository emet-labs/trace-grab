# `trace-corpus-v1`

**Status:** Normative. This document is the contract — implemented by `src/normalize/record.ts`,
enforced by `src/sanitize/`, and the thing `sentinel/ingest` writes an adapter against
([ADR-0004](adr/0004-structural-normalization-only.md),
[ADR-0010](adr/0010-span-shaped-records-and-opaque-tokens.md)). If code and this document
disagree, that's a bug in the code or a stale doc — never a reason to guess.

## Scope

One schema describes two value-spaces:

- **The generic JSONL input** — one `RawRecord` per line, in the vendor's original strings. A
  hand-rolled export in this exact shape needs no parser at all.
- **`trace-corpus-v1`**, the output — one `CorpusRecord` per line, structurally identical to
  `RawRecord`. The only difference is that string values outside the pass-verbatim fields below
  have been replaced with opaque tokens.

A vendor parser's whole job is mapping a native export onto `RawRecord`. Sanitization is a pure
function `RawRecord -> CorpusRecord`, one record at a time, no cross-record state
([ADR-0002](adr/0002-batch-pull-in-v1.md)).

> [!IMPORTANT]
> **The CLI does not perform the requested/completed Event split, derive causal edge classes, or
> apply observation-time rules.** One record is one source span, exactly as the vendor shaped it.
> That split is `sentinel/ingest`'s domain model (sentinel ADR-0015) and stays on Sentinel's side
> of the boundary — see [ADR-0004](adr/0004-structural-normalization-only.md) and
> [ADR-0010](adr/0010-span-shaped-records-and-opaque-tokens.md). A `kind` value is whatever
> string the vendor already used (`"llm"`, `"tool"`, `"chain"`, an OTLP span kind, ...); it is
> copied, never classified.

## Record shape

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | Unique within the corpus. |
| `trace_id` | `string` | Shared by every record in the same trace. |
| `parent_id` | `string \| null` | `null` for a root span. May reference an `id` absent from this corpus — see [Causality](#causality-copied-never-derived). |
| `name` | `string` | Tool / span / run name, as given by the vendor. |
| `kind` | `string` | Vendor's own run/span type string. Not a fixed enum — see the callout above. |
| `start` | `string` | ISO-8601, UTC. |
| `end` | `string \| null` | ISO-8601, UTC. `null` if the vendor recorded no end (in-flight or truncated). |
| `status` | `"unset" \| "ok" \| "error"` | Normalized onto OTLP's three-value status model; a vendor's own vocabulary (e.g. LangSmith `success`/`error`) maps onto this structurally, without added judgment. |
| `error` | `{ kind: string; message: string } \| null` | `null` when `status != "error"` or the vendor gave nothing. |
| `inputs` | JSON value | Arbitrary nested JSON, vendor-shaped. Not flattened — see [ADR-0010](adr/0010-span-shaped-records-and-opaque-tokens.md). |
| `outputs` | JSON value | Same shape rules as `inputs`. |
| `attributes` | `Record<string, JSON value>` | Structured, recognized vendor metadata — OTel-style. |
| `labels` | `Label[]` | Native annotations only; see [ADR-0012](adr/0012-native-annotations-only.md). No sidecar join in v1. |
| `links[]` | `Link[]` | OTLP link object: `{ trace_id, span_id, attributes }`. `[]` when the source has no link concept (e.g. LangSmith). |
| `unmapped` | `Record<string, JSON value>` | Source fields the normalizer didn't recognize, preserved verbatim in shape (not in value — see dispositions below). |
| `source` | `{ vendor: string }` | Which parser produced this record, e.g. `"langsmith"`, `"otlp"`. |

`Label` is `{ key: string; value: JSON value; comment: string | null }`. `key`/`value` carry the
annotation itself (e.g. `key: "correctness"`, `value: "correct"`); `comment` is free text a human
typed alongside it.

## Dispositions — what passes, what tokenizes

[ADR-0005](adr/0005-deny-by-default-equality-preserving-tokenization.md) sets the rule at the
type level (strings tokenize, numbers/booleans/timestamps pass, keys pass, `name`/`kind` are a
named exception). This table is that rule applied to every field this schema actually has,
including the ones ADR-0005 doesn't name individually:

| Field | Default | Why |
| --- | --- | --- |
| `id`, `trace_id`, `parent_id`, `links[].trace_id`, `links[].span_id` | **Tokenized** | Strings, including ids, per ADR-0005's table. Tokenization is value-derived and salt-stable ([ADR-0006](adr/0006-persistent-salt-and-local-keymap.md)), so equal ids still produce equal tokens — topology survives. |
| `name`, `kind` | **Pass verbatim** | Named exception in ADR-0005. The vocabulary every candidate property is expressed in. |
| `start`, `end`, numbers, booleans | **Pass** | Typed passthrough, not string values. |
| `status`, `error.kind` | **Pass** | Categorical signal, not prose. |
| `error.message` | **Tokenized** | Free text. See ADR-0005's accepted cost. |
| `inputs`, `outputs`, `attributes`, `unmapped` — object/array keys | **Pass** | Keys are schema, not data ([ADR-0010](adr/0010-span-shaped-records-and-opaque-tokens.md)). |
| `inputs`, `outputs`, `attributes`, `unmapped` — leaf string values | **Tokenized** | Default string rule, applied per leaf. `unmapped` gets the *same* walk as `attributes` — [ADR-0004](adr/0004-structural-normalization-only.md) point 3: no second redaction code path for fields the normalizer didn't recognize. |
| `labels[].key`, `labels[].value` | **Pass verbatim** | Categorical ground-truth signal (success/failure/human-intervention), the reason [ADR-0012](adr/0012-native-annotations-only.md) ships labels at all. Tokenizing by default would silently require every partner to `reveal: labels.value` just to get the feature's stated purpose. If a vendor's `value` field ever holds prose instead of a short label, `drop: labels.value` is the documented escape — same shape as the `name` trade in ADR-0005. |
| `labels[].comment` | **Tokenized** | Free text a human typed. [ADR-0012](adr/0012-native-annotations-only.md) names this as the largest PII hole in the labels design if it defaults open; that applies identically here, not only to the deferred sidecar. |
| `source.vendor` | **Pass verbatim** | Never partner content — it's assigned by which parser ran, from a closed set trace-grab itself controls. `sentinel/ingest` needs it in the clear to pick the right adapter, and hiding it buys no privacy. |

Every disposition above is the *default*; `tracegrab.yaml` can narrow or widen it per dotted path,
per [ADR-0009](adr/0009-four-disposition-policy-language.md). `SCHEMA.md` states the default a
partner gets with zero configuration, which is also the default the report describes when no
policy file is present.

## Causality: copied, never derived

`parent_id` plus optional `links[]`, copied exactly as the source gave them. Nothing is inferred.

**Dangling `parent_id` values are preserved, not repaired.** A `parent_id` may point to an `id`
that never appears in this corpus — because the source export was partial, because whole-trace
limiting excluded it, or because the vendor's own data is incomplete. `ingest/capture.rs`
already treats an unresolved parent as *evidence about missing evidence* rather than an error,
and sentinel ADR-0019 names this as a case the tracer bullet must handle, not refuse. The
manifest's `dangling_parents` count is how this becomes visible instead of silent; nothing in
`grab` attempts to reattach, drop, or flag the record itself.

Because tokenization is value-derived rather than corpus-relative, a dangling `parent_id`'s token
still equals the token of the record it points to, if that record exists anywhere under the same
salt — including in a different batch. The dangling case only means *this bundle* doesn't contain
the parent, not that the relationship is lost.

## Timestamps

`start` and `end` are ISO-8601 strings, UTC, at whatever sub-second precision the vendor gave
(LangSmith: milliseconds; OTLP: converted from unix nanos). This is the normalizer's job, not the
sanitizer's — timestamps pass by default regardless of representation.

`tracegrab.yaml`'s `time: shift` mode ([ADR-0009](adr/0009-four-disposition-policy-language.md))
applies a single constant per-corpus offset to every `start`/`end` value, derived from the salt so
it's stable across batches. Ordering and every interval survive; absolute position doesn't.

## Manifest

One `manifest.json` per bundle, alongside `corpus.jsonl`. Corpus-level metadata that doesn't
belong on every record line — none of it is subject to the disposition table above; it's
generated by `grab`, not copied from partner content.

| Field | Type | Notes |
| --- | --- | --- |
| `schema_version` | `string` | `"trace-corpus-v1"`. |
| `generator` | `{ name: string; version: string }` | The tool and version that produced this bundle. |
| `generated_at` | `string` | ISO-8601, when `grab` ran. |
| `source` | `{ vendor: string }` | Same vendor tag as each record's `source.vendor`. |
| `counts` | `object` | `traces`, `records`, `distinct_paths`, `distinct_tokens`, `dangling_parents`, `excluded_traces`. |
| `policy_hash` | `string` | SHA-256 of the effective `tracegrab.yaml` (or of the built-in defaults, if none was supplied). |
| `corpus_sha256` | `string` | SHA-256 of `corpus.jsonl`, so the manifest and the corpus can't drift apart silently. |
| `partner_label` | `string \| null` | Optional partner-supplied label for this batch. |
| `warnings` | `string[]` | Unmatched-policy-path warnings and anything else surfaced during the run. |

```json
{
  "schema_version": "trace-corpus-v1",
  "generator": { "name": "@emetlabs/trace-grab", "version": "0.1.0" },
  "generated_at": "2026-08-14T09:12:03.000Z",
  "source": { "vendor": "langsmith" },
  "counts": {
    "traces": 412,
    "records": 6810,
    "distinct_paths": 137,
    "distinct_tokens": 4021,
    "dangling_parents": 3,
    "excluded_traces": 0
  },
  "policy_hash": "b7e2...",
  "corpus_sha256": "9f14...",
  "partner_label": "acme-2026-08",
  "warnings": []
}
```

## Worked example

A single LangSmith run, as it would appear in the generic JSONL input, and the corresponding
`trace-corpus-v1` record after sanitization with no `tracegrab.yaml` (built-in defaults only).

**Input record** (`RawRecord`, one line of `corpus.jsonl`-shaped input):

```json
{
  "id": "1a2b3c4d-5e6f-4a1b-8c2d-9e0f1a2b3c4d",
  "trace_id": "9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f",
  "parent_id": "5a4b3c2d-1e0f-4b2a-9c8d-7e6f5a4b3c2d",
  "name": "authenticate_user",
  "kind": "tool",
  "start": "2026-08-01T14:03:22.104Z",
  "end": "2026-08-01T14:03:22.481Z",
  "status": "ok",
  "error": null,
  "inputs": { "user_id": "u_48213", "session_token": "sess_9f2a7c1e" },
  "outputs": { "authenticated": true, "account_id": "acct_7734" },
  "attributes": {},
  "labels": [{ "key": "correctness", "value": "correct", "comment": null }],
  "links": [],
  "unmapped": { "tags": ["auth", "critical-path"], "extra": { "metadata": { "environment": "production" } } },
  "source": { "vendor": "langsmith" }
}
```

**Corpus record** (`CorpusRecord`, the same line after sanitization):

```json
{
  "id": "TOK_4f19a2e8c3",
  "trace_id": "TOK_9b7e0d1a5c",
  "parent_id": "TOK_2c8a4f6b91",
  "name": "authenticate_user",
  "kind": "tool",
  "start": "2026-08-01T14:03:22.104Z",
  "end": "2026-08-01T14:03:22.481Z",
  "status": "ok",
  "error": null,
  "inputs": { "user_id": "TOK_a3d17c9e02", "session_token": "TOK_6e5b28f4a1" },
  "outputs": { "authenticated": true, "account_id": "TOK_d091ef3b7c" },
  "attributes": {},
  "labels": [{ "key": "correctness", "value": "correct", "comment": null }],
  "links": [],
  "unmapped": { "tags": ["TOK_c4a819e3f0", "TOK_71b4de6a92"], "extra": { "metadata": { "environment": "TOK_58fa2c0e91" } } },
  "source": { "vendor": "langsmith" }
}
```

`name`, `kind`, `status`, timestamps, the boolean `authenticated`, `labels[].key`,
`labels[].value`, and `source.vendor` are unchanged. Every other string leaf — including `id`,
`trace_id`, `parent_id`, and the ones inside `unmapped` — became a token. Object keys throughout
(`user_id`, `account_id`, `tags`, `environment`, ...) are unchanged; that's the path a reviewer
reads in `report.md` and the path a `tracegrab.yaml` rule matches against.
