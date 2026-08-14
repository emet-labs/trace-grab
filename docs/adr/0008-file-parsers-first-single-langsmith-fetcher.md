# ADR-0008 · File parsers are the default path; one API fetcher

**Status:** Decided.

## Context

The campaign doc frames adapters as integrations — "point it at LangSmith, select a project and a
date range." An API-pulling adapter needs a LangSmith API key, which is broad read access to the
partner's **entire** trace history across projects. The reviewer's question then changes from
"what is in the bundle" to "what could this process have read", which is the anxiety the whole
design exists to remove.

LangSmith and Braintrust both already have native export, as the campaign doc itself notes.

## Decision

- **File parsers are the documented default in outreach.** v1 ships three: generic JSONL,
  LangSmith export, OTLP JSON. Braintrust is deferred until a partner asks.
- **One API fetcher — LangSmith — as a convenience**, opt-in, never the advertised path.

### Constraints on the fetcher

1. **Fetcher / parser split.** The fetcher only *fetches* and hands the vendor's native records to
   the same parser the file mode uses. No second normalization path and no second place for the
   policy to be applied differently. API mode is a fetch layer, not a parallel pipeline.
2. **No vendor SDKs — plain `fetch` against documented REST endpoints.** Keeps the dependency
   budget at one and avoids being pinned to an SDK's release cadence.
3. **Credentials from environment variables only.** Never a flag (shell history), never written
   to disk, never logged, scrubbed from error output. The README names the exact endpoints called.
4. **Resumable.** A six-month backfill will hit a rate limit or a closed laptop lid. A checkpoint
   file means resume, not restart — otherwise the failure mode is a partner abandoning the one
   export we were ever going to get.

## Rationale for file-first

Zero credentials, zero vendor SDKs, offline-capable, trivially testable from fixtures, and the
tool **physically cannot have read more than the files it was handed**. That property is worth
more to this program than saving a partner one click in an export UI.

It also hedges an unknown: we do not yet know what the first five targets run. A new vendor
becomes a parser over a file they can email us, rather than an integration.

## Alternatives rejected

- **API clients as the primary path.** The credential ask lands in the same conversation as
  "trust us with your data".
- **Braintrust fetcher in v1.** Its export UI already covers the file path; build the fetcher the
  day a partner says the UI is annoying, against their real workflow instead of a guess.
- **An OTel "fetcher".** OTel is push-based; there is nothing to pull. The OTel path is either a
  file of OTLP JSON (covered) or the live collector deferred by
  [ADR-0002](0002-batch-pull-in-v1.md).
