# trace-grab — Product Requirements

**Package:** `@emet/trace-grab` · **Binary:** `trace-grab` · **License:** Apache-2.0 · **Status:** Scaffolding

## 1. Why this exists

The [Trace Partnership Campaign](#related-documents) trades sanitized production agent traces
for a findings package. Nothing in that exchange happens until a partner can get their traces
out of their environment and into ours **without their security reviewer saying no**.

`trace-grab` is that step. It is the utility we ask a partner to download and run against their
own agentic system. It reads trace exports they already have, normalizes them structurally,
tokenizes their content, and writes a bundle to their own disk. They inspect it. They send it
to us however their company prefers.

The tool is open source; the rest of the product is not. That asymmetry is deliberate and is
the entire reason the tool works — see [ADR-0001](adr/0001-contributor-side-only-and-open-source.md).

> [!IMPORTANT]
> The approver — not the runner — is the audience for most of this design. They will never type a
> command. They read the report, skim the README, and decide whether the transfer happens.

## 2. Who runs it

- **The runner:** a platform / AI-infra engineer at an AI-native startup or mid-size company
  running production agents. Comfortable with a CLI, has access to their observability data,
  does *not* want a project.
- **The approver:** a security, privacy, or legal reviewer at the same company. Usually never
  runs the tool. Reads its output and its README and decides whether the transfer happens.

The approver is the harder audience and most design decisions here are aimed at them.

## 3. Goals

1. A partner can produce a shareable, sanitized corpus in one command with zero configuration.
2. A reviewer can determine what leaves the environment **by construction**, not by trusting us.
3. The corpus preserves everything runtime verification needs: topology, ordering, tool
   identity, status, timing, and **identity relationships between values**.
4. The corpus preserves nothing else by default.
5. `sentinel/ingest` can adapt the corpus without the corpus knowing anything about Sentinel.

## 4. Non-goals

- **Not** an analysis tool. It mines nothing, scores nothing, and renders no findings.
- **Not** a live agent or a production sidecar. It runs once, on a laptop or a CI box.
- **Not** an uploader. It has no Emet endpoint ([ADR-0007](adr/0007-zero-emet-egress.md)).
- **Not** a Sentinel component. It never imports the canonical model and never encodes
  Sentinel semantics ([ADR-0004](adr/0004-structural-normalization-only.md)).
- **Not** an anonymizer. Pseudonymization is not anonymization; the docs say so plainly.

## 5. The trust model in one page

Everything a reviewer needs to believe reduces to four checkable claims:

| Claim | How they check it |
| --- | --- |
| "It cannot send anything to Emet." | `grep -ri emet src/` returns nothing but the package scope. Network primitives appear in exactly one file, and only for *their own* vendor's API. |
| "It cannot read more than I gave it." | Default path takes a directory of files they exported themselves. No credentials involved. |
| "I can see everything that leaves in plaintext." | The bundle's report lists every attribute path that passes verbatim — a complete, bounded list, typically under 200 entries for a corpus of 100k+ events. |
| "The published package is the code I read." | npm provenance attestation ties the tarball to a commit and a workflow run. |

> [!WARNING]
> Every one of those claims is voided by a single routine engineering decision: adding telemetry,
> an update check, error reporting, a license ping, a bundled minified blob, or a second runtime
> dependency nobody reads. They are all defensible in a normal CLI and all fatal here.

The fifth, unwritten claim — "the redaction is thorough" — is deliberately *not* on this list.
Thoroughness is a property of detectors, and detectors fail open. The tool instead tokenizes
everything by default so that thoroughness is not a variable
([ADR-0005](adr/0005-deny-by-default-equality-preserving-tokenization.md)).

## 6. Scope — v1

### Verbs

| Verb | Behaviour |
| --- | --- |
| `grab <input>` | Read → normalize → sanitize → write bundle + report, in one streaming pass. Non-interactive, CI-safe. Never stages raw traces on disk. |
| `check --value <v> <bundle>` | Tokenize a value with the local salt and report exactly where it appears in the bundle, as token and as plaintext. |

There is no `push`, no `review`, and no interactive prompt. `grab` writes the report; `check`
is how a reviewer interrogates it.

### Sources

| Source | Mode | v1 |
| --- | --- | --- |
| Generic JSONL | file | yes |
| LangSmith export | file | yes |
| OTLP JSON | file | yes |
| LangSmith API | network | yes — the only networked module |
| Braintrust | file | deferred until a partner asks |
| OTel collector redactor | live | deferred (see [ADR-0002](adr/0002-batch-pull-in-v1.md)) |

### Output — the bundle

A directory, not an archive:

```
corpus/
  corpus.jsonl     one span-shaped record per line, trace-corpus-v1
  manifest.json    schema version, generator version, counts, policy hash, corpus digest
  policy.yaml      the exact policy that produced this corpus
  report.md        the path inventory and the verbatim list
```

Transfer is documented, not built: `tar -czf` plus a `curl -T` against a presigned URL we mint
per batch.

## 7. Data contract

Defined normatively in `SCHEMA.md` (issue #2). Summary:

- **Span-shaped** records — one per source unit of work. The requested/completed split, causal
  edge derivation, and observation-time handling stay in `sentinel/ingest`.
- **Causality copied, never derived**: `parent_id` and `links[]` only. Dangling parents are
  preserved as evidence about missing evidence, per sentinel ADR-0019.
- **Nested attributes preserved**; dotted paths are the query language shared by the policy,
  the inventory, and the report.
- **Verbatim by default:** attribute keys, `name`, `kind`, `status`, `error.kind`, timestamps,
  durations, numbers, booleans.
- **Tokenized by default:** every string value, including ids and `error.message`.
- **Opt-in only:** any plaintext string value, via `reveal:`.

> [!CAUTION]
> Tool and span names pass verbatim, and a name can itself disclose something — a tool called
> `notify_bankruptcy_counsel` says a great deal. This is a deliberate trade, stated in
> `THREAT-MODEL.md` rather than buried.

Tool and span **names pass verbatim**. This is a real disclosure — a tool named
`notify_bankruptcy_counsel` says something — and it is stated in `THREAT-MODEL.md` rather than
buried, because names are the vocabulary the entire analysis is built on.

## 8. Program constraints that bind the tool

- **The ask is narrow.** One project, 2–4 weeks, roughly 20–50k events. Not six months of
  everything. `--since` / `--until` / `--max-traces` exist to make the small ask easy to honour,
  and limiting is whole-trace only ([ADR-0011](adr/0011-whole-trace-limiting.md)).
- **No turnaround promise in cohort-one outreach.** The findings generator does not exist and
  the first packages are hand-made. A hard SLA starts at Tier 2.
- **A written misconfiguration protocol ships before outreach** (issue #23). Someone will
  eventually `reveal:` a field they shouldn't. Quarantine, notify, delete on request, confirm in
  writing, never propagate to derived artifacts.
- **Detection runs on our side, as an alarm** ([sentinel#80](https://github.com/emet-labs/sentinel/issues/80)). Detectors are unacceptable as a
  redaction mechanism because a false negative leaks; as a receiving-end alarm a false negative
  costs nothing and a true positive means we catch a partner's mistake before they do.

## 9. Success criteria

| | Signal |
| --- | --- |
| Adoption | A partner completes `grab` with zero configuration and zero questions to us. |
| Trust | At least one partner's security reviewer approves the transfer citing the report or the source, not a call with us. |
| Fidelity | The SagaShop semantic gate ([sentinel#78](https://github.com/emet-labs/sentinel/issues/78)) shows known properties remain minable post-sanitization. |
| Leakage | Canary suite green; zero plaintext findings from the ingest-side alarm across cohort one. |
| Reuse | `sentinel/ingest` adapts `trace-corpus-v1` without a change to the corpus format. |

npm download count is the public adoption metric. It requires no telemetry, which is the point.

## 10. Open questions

1. Braintrust file parser — build speculatively, or on first request? Currently deferred.
2. Does the corpus need a partner-supplied free-text "what this system does" note to make
   findings useful, and if so where does it live given it is unstructured text?
3. Whether `--max-traces` selection should be seeded by salt (stable per partner) or by corpus
   (stable per batch) when a partner contributes repeatedly.

## Related documents

- Trace Partnership Campaign — program doc (Google Docs)
- `sentinel/docs/PRD.md` — the product this corpus feeds
- `sentinel/docs/adr/0026-data-governance-tenant-isolation-retention-redaction.md` — the
  governance model this tool sits *outside* of, per
  [ADR-0014](adr/0014-corpus-data-is-a-distinct-class.md)
- `sentinel/docs/adr/0019-design-partner-led-tracer-bullet.md` — dangling-parent handling
- `sentinel/docs/adr/0016-cross-system-action-sequence-verification.md` — why equality
  preservation is load-bearing
