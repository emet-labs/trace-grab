# ADR-0002 · Batch pull in v1; the live tap is deferred

**Status:** Decided.

## Context

The campaign doc describes two tools under one name. **Batch pull:** point the CLI at an export,
get history, write a file. **Live tap:** a second OTel exporter feeding a long-running local
redactor alongside their application.

These are different programs. A live tap is a daemon in a production data path — it needs a
deploy, an owner, and an uptime story, and its failure mode is dropping or backpressuring the
partner's real telemetry.

## Decision

**v1 is batch pull only.** The live tap remains possible as a later mode of the same tool, not
as a rewrite.

## Rationale

- Tier 1 is explicitly *historical* trace data, and Tier 1 is the largest pool and the point of
  the campaign. Ongoing contribution is a Tier 2 concern and Tier 2 does not exist yet.
- Batch pull has a trust property a stream cannot have: the partner sees the **complete artifact
  before anything leaves**. Streaming converts "review, then send" into "trust our redactor in
  real time", which is exactly the trust not yet earned.
- The first partners are handing over months of history in one shot. Nobody's live stream matters
  until there is a research partner.

## Consequence that constrains the build

Sanitization must be a **pure function over a single normalized record**, with no dependence on
batch-ness — no "collect everything, then decide". The one place that is genuinely tempting is
pseudonym assignment, which is resolved by making tokens depend only on the value and a
persistent salt ([ADR-0006](0006-persistent-salt-and-local-keymap.md)), never on corpus-wide
statistics or first-seen ordering.

## Alternatives rejected

- **Live tap first,** on the grounds that OTel is the broadest-applicability path. Rejected: it
  front-loads a production deployment ask onto the coldest conversation in the funnel.
- **Both at once.** Doubles the surface before a single partner exists.
