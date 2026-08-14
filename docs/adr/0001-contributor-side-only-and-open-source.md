# ADR-0001 · trace-grab is contributor-side only, and open source

**Status:** Decided.

## Context

The Trace Partnership Campaign lists eight pieces of infrastructure. Four could plausibly be
called "the trace grab utility": the sanitizer, the platform adapters, the upload endpoint, and
the findings-package generator. They have opposite properties. The sanitizer must be readable by
a hostile stranger. The findings generator is the commercial asset and shares vocabulary with
`sentinel/core` and the Pattern catalogue.

## Decision

`trace-grab` is **the contributor-side CLI and nothing else**, and it is **Apache-2.0 open
source** while the rest of the product remains proprietary.

- In scope: read a partner's trace export, normalize it, sanitize it, write a bundle.
- Out of scope: findings generation, spec mining, the ingestion service, any Sentinel model type.

## Why open source, precisely

Not as community strategy — [the campaign doc is explicit that this is not a community
launch](../PRD.md#related-documents). Open source here buys exactly one thing: the claim
*"nothing leaves except what you see"* becomes checkable instead of promised.

> [!WARNING]
> This purchase is conditional and fragile. It survives only while the repo stays small enough to
> read in one sitting and adds nothing that phones home.

That purchase is conditional and fragile. It holds only while the repo is small enough to read
in one sitting and contains **no telemetry, no analytics, no auto-update, no error reporting, no
license ping, and no bundled minified blobs**. Every one of those is a defensible engineering
choice in a normal CLI and every one of them silently voids the entire strategy here.

## Alternatives rejected

- **Findings generator in the same repo.** Forces a choice between open-sourcing the spec miner
  and shipping a public repo with a proprietary subdirectory. The second kills the credibility
  signal being paid for. It would also need `sentinel/model`'s canonical Event types, coupling a
  public tool to a proprietary workspace.
- **Keep it closed and ship a binary.** Every trust claim reverts to "trust us", which is
  precisely the position the campaign exists to escape.
- **MIT instead of Apache-2.0.** The explicit patent grant matters when the goal is surviving a
  corporate legal review; enterprise OSS-approval processes have a well-worn Apache-2.0 path.

## Consequences

- The receiving service and findings generator live in `sentinel/`, behind the untrusted-input
  boundary that `ingest/capture.rs` already establishes.
- Dependency additions are governance decisions, not routine (see
  [ADR-0007](0007-zero-emet-egress.md)).
- The repo carries a `THREAT-MODEL.md` stating its own limits. A tool that names what it does
  not protect against is one a reviewer can trust about what it does.
