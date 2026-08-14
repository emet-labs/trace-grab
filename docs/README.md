# trace-grab docs

`@emet/trace-grab` — the utility a Trace Partnership Program partner downloads and runs against
their own agentic system. It reads trace exports they already have, normalizes them structurally,
tokenizes their content, and writes a bundle to their own disk. **It never contacts Emet.**

> [!NOTE]
> Nothing is implemented yet. This directory is the design: a PRD, fourteen ADRs, and the work
> filed as GitHub Issues.

| | |
| --- | --- |
| [PRD.md](PRD.md) | What it is, who runs it, what ships in v1, and the constraints the program puts on the tool. |
| [adr/](adr/) | 14 decisions, each with what was rejected and why. |
| [GitHub Issues](https://github.com/emet-labs/trace-grab/issues) | 26 issues across three repos, sequenced with a critical path. Milestones M0–M5. |

## The decisions, in one table

| ADR | Decision |
| --- | --- |
| [0001](adr/0001-contributor-side-only-and-open-source.md) | Contributor-side CLI only, Apache-2.0, while the product stays proprietary. |
| [0002](adr/0002-batch-pull-in-v1.md) | Batch pull in v1; the live OTel tap is deferred. |
| [0003](adr/0003-bun-for-development-node-for-distribution.md) | Bun for development, Node-compatible output for partners. |
| [0004](adr/0004-structural-normalization-only.md) | The CLI normalizes structure and never models semantics. |
| [0005](adr/0005-deny-by-default-equality-preserving-tokenization.md) | **Deny by default; preserve equality.** The load-bearing decision. |
| [0006](adr/0006-persistent-salt-and-local-keymap.md) | Persistent local salt plus a local reverse keymap. |
| [0007](adr/0007-zero-emet-egress.md) | No `push` verb and no Emet endpoint anywhere in the source. |
| [0008](adr/0008-file-parsers-first-single-langsmith-fetcher.md) | File parsers are the default path; one LangSmith fetcher as a convenience. |
| [0009](adr/0009-four-disposition-policy-language.md) | Four dispositions, dotted paths, YAML. |
| [0010](adr/0010-span-shaped-records-and-opaque-tokens.md) | Span-shaped records, nested attributes, opaque tokens. |
| [0011](adr/0011-whole-trace-limiting.md) | Limiting is whole-trace, never per-span. |
| [0012](adr/0012-native-annotations-only.md) | Labels ride along natively; the sidecar join is deferred. |
| [0013](adr/0013-metamorphic-tests-here-semantic-gate-in-sentinel.md) | Metamorphic tests here; the SagaShop semantic gate in sentinel. |
| [0014](adr/0014-corpus-data-is-a-distinct-class.md) | Corpus data is a distinct class from monitored-tenant data. |

## Where the work is tracked

GitHub Issues, milestones **M0–M5**. `repo:` labels mark the six items that belong to other repos —
four in `emet/sentinel` (semantic gate, mirror ADR, ingest adapter, detector alarm) and two program
documents.

> [!IMPORTANT]
> Two gates are non-negotiable. **Before the first partner:** the SagaShop semantic gate (#21) and
> the written misconfiguration protocol (#23) — one proves sanitization is not destroying the
> signal we are asking for, the other is what we do when a partner reveals a field they should not
> have. **Before any public release:** the no-egress test (#17) and provenance publishing (#18).

## If you read only one thing

[ADR-0005](adr/0005-deny-by-default-equality-preserving-tokenization.md). Every string value is
tokenized by default and plaintext is opt-in per path, which makes the claim *"we cannot read your
data; we can only see that this field equals that one"* true **by construction** rather than true
if the regexes were good. Runtime verification needs equality, not content — so almost nothing is
lost, and the trust argument stops depending on our thoroughness.

The second thing is [ADR-0014](adr/0014-corpus-data-is-a-distinct-class.md), which reconciles this
repo with sentinel ADR-0026's rejection of redact-at-source. They are not in conflict: redaction
destroys verifiability for *enforcement*, not for *discovery*.
