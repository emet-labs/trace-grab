# ADR-0014 · Corpus data is a distinct class from monitored-tenant data

**Status:** Decided here; **a mirror ADR must land in `sentinel/docs/adr/`** (issue #22).

## Context — an apparent contradiction

Sentinel ADR-0026 §7 explicitly **rejects redact-at-source**:

> Redact-at-source was rejected: Sentinel cannot verify or enforce on what it never saw, which
> breaks the enforceable fragment for any Specification binding sensitive attributes.

`trace-grab` is redact-at-source. Left unwritten, that reads as this repo contradicting the
product's governance ADR.

## Decision

It does not contradict it, because **the monitored-tenant path and the corpus path are different
systems with different jobs**, and this ADR states that boundary explicitly.

| | Monitored tenant (ADR-0026) | Corpus (this repo) |
| --- | --- | --- |
| Job | Evaluate Verdicts, enforce in the hot path | Mine candidate properties offline |
| Needs plaintext? | **Yes** — `Decide` binds real values | **No** — mining never resolves a token |
| Redaction point | After settle, at rest | Before it leaves the partner's environment |
| Governs | Tenant data under a contract | Donated data under a DUA |

Redaction destroys verifiability **for enforcement**. It does not destroy it **for discovery**.
That is the whole reconciliation, and it is why deny-by-default is safe here and would be wrong
there.

## Two consequences that are silently wrong if unwritten

> [!IMPORTANT]
> Neither of these produces an error when violated. Both produce plausible-looking results that
> are wrong in ways nobody notices until much later.

1. **Corpus data must never flow into the monitored-tenant path.** The Sentinel ingest boundary
   treats corpus data as a distinct class — not merely another `tenant_id`. Nothing in ADR-0026's
   tenancy, RLS, retention, or evidence-extract model applies to it, and applying it by accident
   would give donated data the wrong retention and the wrong access semantics.
2. **A property mined from a corpus is scoped to tokens, not to attribute paths with real
   values.** Promoting one to a real Specification is a **re-authoring step** against the tenant's
   actual attributes — never a copy. Treating a mined candidate as directly promotable would
   produce Specifications that bind variables no probe ever emits.

## Also worth stating in the mirror ADR

- Corpus retention follows the DUA (default 6 months, deletable on request), **not** ADR-0026 §6's
  30-day raw-Event window.
- The evidence-extract model (§8) has no analogue here: there are no Verdicts over corpus data and
  therefore no binding values to preserve.
- Break-glass (§4) does not apply; corpus data has no tenant to notify.
