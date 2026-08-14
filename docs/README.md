# Design notes

Internal. The partner-facing documentation is the [root README](../README.md); nothing in this
directory is written for a contributor of traces.

| | |
| --- | --- |
| [PRD.md](PRD.md) | What we're building, who runs it, what ships in v1, and the program constraints that bind the tool. |
| [adr/](adr/) | The decisions, each recording what was rejected and why. Numbered, append-only — supersede rather than edit. |
| [Issues](https://github.com/emet-labs/trace-grab/issues) | The work. Milestones M0–M5; `repo:` labels mark items belonging to `emet/sentinel` or the campaign docs. |

## Reading order

Start with the PRD. If you only read two ADRs, read
[0005](adr/0005-deny-by-default-equality-preserving-tokenization.md) — deny by default, preserve
equality, which is the decision every other one is downstream of — and
[0014](adr/0014-corpus-data-is-a-distinct-class.md), which reconciles this repo with sentinel
ADR-0026's rejection of redact-at-source.

> [!IMPORTANT]
> Two gates before shipping. **Before the first partner:** the SagaShop semantic gate
> ([#21](https://github.com/emet-labs/trace-grab/issues/21)) and the written misconfiguration
> protocol ([#23](https://github.com/emet-labs/trace-grab/issues/23)). **Before any public
> release:** the no-egress test ([#17](https://github.com/emet-labs/trace-grab/issues/17)) and
> provenance publishing ([#18](https://github.com/emet-labs/trace-grab/issues/18)).
