# Policy resolution — how `tracegrab.yaml` dispositions interact

**Status:** Normative. Implements [ADR-0009](adr/0009-four-disposition-policy-language.md).
If code and this document disagree, that's a bug in the code.

## The four dispositions

| Disposition | Meaning |
| --- | --- |
| `reveal` | Pass the value verbatim — no tokenization. |
| `tokenize` | Replace the value with a `TOK_` token. Appears in config only to narrow an over-broad `reveal`. |
| `drop` | Remove the field entirely. |
| `default` | No rule matched. Apply the built-in SCHEMA.md disposition (pass-verbatim fields pass; string leaves tokenize; numbers/booleans/null pass). |

`default` is not something a partner writes in `tracegrab.yaml` — it is what `decide(path)` returns when no
rule matches. The sanitize walk then applies the built-in behavior from the SCHEMA.md disposition table.

## Resolution algorithm

Given a concrete dotted path and a parsed policy:

1. **Collect** all rules (across `reveal[]`, `tokenize[]`, `drop[]`) whose pattern matches the path.
2. **If none match**, return `default`.
3. **Find the most specific** matching rule, using `compareSpecificity` (literal segment count first, then
   total segment count — fewer wildcards wins).
4. **If there is a unique most-specific rule**, its disposition wins.
5. **If multiple rules tie on specificity**, the most restrictive disposition wins:
   `drop` (0) > `tokenize` (1) > `reveal` (2).

Step 3 is the primary key. Step 5 is the tie-breaker only. This is the only reading consistent with
`tokenize`'s stated purpose — narrowing an over-broad `reveal` — which requires a more-specific
`tokenize` to override a less-specific `reveal`.

> [!IMPORTANT]
> "Failing closed is the only acceptable ambiguity resolution in a security config" (ADR-0009). The
> tie-breaker encodes this: when two rules are equally specific, the one that removes more information
> wins.

## Truth table

### Cross-specificity (most-specific wins)

| Most specific drop? | Most specific reveal? | Most specific tokenize? | Result | Why |
| --- | --- | --- | --- | --- |
| ✓ (higher spec) | ✓ (lower) | — | `drop` | More specific wins |
| ✓ (lower) | ✓ (higher) | — | `reveal` | More specific wins |
| ✓ (higher) | — | ✓ (lower) | `drop` | More specific wins |
| ✓ (lower) | — | ✓ (higher) | `tokenize` | More specific wins |
| — | ✓ (higher) | ✓ (lower) | `reveal` | More specific wins |
| — | ✓ (lower) | ✓ (higher) | `tokenize` | More specific wins |

### Equal specificity (tie-break by restrictiveness)

| Drop? | Reveal? | Tokenize? | Result |
| --- | --- | --- | --- |
| ✓ | ✓ | — | `drop` |
| ✓ | — | ✓ | `drop` |
| — | ✓ | ✓ | `tokenize` |
| ✓ | ✓ | ✓ | `drop` |
| ✓ | — | — | `drop` |
| — | ✓ | — | `reveal` |
| — | — | ✓ | `tokenize` |

## Worked examples

```yaml
# Example 1: reveal carves out from a broad drop
drop:
  - inputs.**            # specificity: 1 literal, 2 segments
reveal:
  - inputs.user.email    # specificity: 3 literals, 3 segments
```

`decide("inputs.user.email")` → both rules match. `inputs.user.email` is more specific (3 literals > 1).
Result: **`reveal`**. The partner explicitly carved this path out of the drop.

```yaml
# Example 2: equal specificity → fail closed
drop:
  - inputs.user.email    # 3 literals, 3 segments
reveal:
  - inputs.user.email    # 3 literals, 3 segments
```

Tie on specificity. `drop` is more restrictive. Result: **`drop`**.

```yaml
# Example 3: tokenize narrows a broad reveal
reveal:
  - inputs.**            # 1 literal, 2 segments
tokenize:
  - inputs.user.secret   # 3 literals, 3 segments
```

`decide("inputs.user.secret")` → both match. `inputs.user.secret` is more specific. Result: **`tokenize`**.

```yaml
# Example 4: no rules match
reveal:
  - outputs.status
```

`decide("inputs.user.email")` → no rule matches. Result: **`default`** → built-in tokenize (string leaf,
not in the pass-verbatim list).

## Required fields

Top-level record fields (`id`, `trace_id`, `parent_id`, `name`, `kind`, `start`, `end`, `status`,
`error.kind`, `error.message`, `source.vendor`) and structurally required fields (`labels[*].key`,
`labels[*].value`, `links[*].trace_id`, `links[*].span_id`) cannot be removed from the record.

For these fields, `drop` is treated as the next most restrictive disposition:
- **String fields** (`id`, `name`, `error.message`, ...): `drop` → `tokenize`.
- **Non-string fields** (`labels[*].value` when it holds a number): `drop` → `default` (pass).
- **`status`** (enum): always passes — it is not free text and carries no PII.

`drop` on a key *inside* a bag (`inputs.user.email`, `unmapped.note`, ...) removes that key from the
output object. This is the normal, supported use of `drop`.

## Unknown keys

A typo'd top-level key in `tracegrab.yaml` is a **hard error**. The CLI exits non-zero, names the
offending key, and lists the valid keys. No corpus is written.

Valid keys: `version`, `reveal`, `tokenize`, `drop`, `time`.

## Unmatched-rule warnings

Every rule that matched zero paths in the corpus is reported in the manifest's `warnings` array and
surfaced in the report. This is the classic redaction failure: a rule written against a half-remembered
field name, silently matching nothing (ADR-0009).

## `time: shift`

When `time: shift` is set, `start` and `end` timestamps are shifted by a single per-corpus constant
derived from the salt (ADR-0006). Ordering and every interval survive; absolute position doesn't.
The default is `time: absolute` — timestamps pass through unchanged.
