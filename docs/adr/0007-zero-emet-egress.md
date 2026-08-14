# ADR-0007 · The tool has no Emet endpoint

**Status:** Decided. Supersedes the campaign doc's `push` / upload-endpoint design for v1.

## Context

Deny-by-default answers *"what is in the bundle?"* It says nothing about *"did the tool also POST
a copy somewhere while it ran?"* A reviewer taking the trust question seriously asks the second
one, and the answer must be checkable without reading every line of source.

## Decision

**`trace-grab` never contacts Emet. There is no `push` verb and no Emet endpoint anywhere in the
source** — not a default, not a config key, not a commented-out URL.

Four supporting rules:

1. **Network primitives appear in exactly one module** — the LangSmith fetcher
   ([ADR-0008](0008-file-parsers-first-single-langsmith-fetcher.md)) — and it talks only to the
   partner's own vendor. Enforced by a CI test that greps the tree.
2. **A local-file source exists from day one**, so the whole pipeline is exercisable fully
   offline. It is also the test harness and the "custom logs" path.
3. **npm provenance attestation** on release, tying the published tarball to a commit and a
   workflow run. Open source means nothing if the tarball was built on someone's laptop.
4. **No telemetry, analytics, update check, error reporting, or license ping.** Ever.

## Rationale

This is a stronger position than a well-designed uploader, and it costs almost nothing:

> [!TIP]
> There is no Emet endpoint in this source. Grep for it.

A claim verifiable with `grep` beats every paragraph of README prose about security posture. It
also converts the reviewer's task from code reading into observation — run it behind a proxy and
watch.

## How transfer actually happens

Documented, not built. We mint a **presigned URL per batch**, out of band; the partner runs
`tar -czf` and `curl -T`. Their own trusted tool does the sending. Same ergonomics as a `push`
verb, none of the trust cost, no service to operate, and the per-batch URL is a natural
governance checkpoint — a human moment tied to each transfer instead of a standing credential
that keeps working after the relationship ends.

The escape hatch stays documented and unembarrassed: *"or send us the tarball however your
company prefers."* Some of the best targets have a mandated transfer process.

## Alternatives rejected

- **Dedicated ingestion API.** CLI carries a long-lived credential and a baked-in endpoint;
  verifying the destination becomes code reading; requires building and operating an
  authenticated service before partner number one.
- **Presigned-URL `push` verb in the CLI.** Was the recommendation until the stronger claim above
  became available. A `--to` flag is honest, but "there is no endpoint at all" is unarguable.
