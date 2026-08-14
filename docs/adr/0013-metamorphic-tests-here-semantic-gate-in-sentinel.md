# ADR-0013 · Metamorphic tests here; the semantic gate lives in sentinel

**Status:** Decided.

## Context

The campaign doc names "sanitizer over-redacts and destroys relational information" as a
medium-likelihood, high-impact risk, with the SagaShop testbed as the mitigation. But that check
needs both the property matrix and the miner, and the miner is proprietary — so the test cannot
live entirely in an open-source repo.

`sentinel/testdata/sagashop/` already contains `scenario-property-matrix.json`, `ts-happy.json`,
`ts-cancel.json`, and `ts-hazards.json`, so the gate is buildable today rather than hypothetical.

## Decision — the split

### In `trace-grab` (open source): metamorphic properties, no Sentinel code required

| Test | Property |
| --- | --- |
| **Canary leak** | Fixtures seeded with unique markers at every position — keys, deep nested values, array elements, error messages, the unmapped bag. The bundle contains **zero** canaries except at explicitly revealed paths. |
| **Equality preservation** | Leaves equal pre-sanitization have equal tokens; unequal stays unequal. Property-based over generated nested JSON. |
| **Topology preservation** | Record count, parent/child structure, ordering, and links are unchanged. |
| **Determinism** | Same input + same salt → byte-identical `corpus.jsonl`. |
| **Idempotence** | Sanitizing a sanitized bundle changes nothing. |
| **No egress** | Grep of the tree: no Emet domain, network primitives only in the fetcher module. |

The canary suite is the one to build first. It is an **automated proof** of the deny-by-default
claim rather than a promise about it, and it is the test to point at in the README.

### In `sentinel` (proprietary): the semantic gate — follow-on, before first partner

Convert `testdata/sagashop/ts-*.json` to the generic corpus input, run `trace-grab`, feed the
result to `ingest`, and assert `scenario-property-matrix.json` still holds. It belongs on the side
that owns the matrix and the miner, and it doubles as a regression gate on the format contract: if
`trace-corpus-v1` changes shape, the test breaks in the repo that cares.

## Explicit non-decision

**No `capture-envelope-v1` parser in `trace-grab`.** SagaShop is an internal testbed format with
no business in a public tool. The sentinel-side gate converts to the generic input schema instead.

## Sequencing

Metamorphic tests ship with the first working sanitizer. The semantic gate is a follow-on ticket
in the sentinel repo, required **before the first partner**, not before the first commit.
