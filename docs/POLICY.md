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

## Path syntax

Policy entries use the same dotted paths printed in `report.md` and documented in
[`SCHEMA.md`](SCHEMA.md):

- `.` separates object segments: `inputs.user.email`.
- `*` matches exactly one segment: `inputs.*.email` matches `inputs.user.email`, but not
  `inputs.user.profile.email`.
- `**` matches zero or more segments: `inputs.**` matches `inputs` and every descendant.
- Array elements use a literal `[*]` suffix on their parent segment:
  `inputs.items[*].sku`. Every element shares that path; numeric indexes are not part of the
  policy language.

There is no escaping syntax. A source key containing `.` or a wildcard token cannot be targeted
unambiguously. Use the path inventory in the generated report to copy the path the sanitizer
actually observed, and treat an unmatched-rule warning as a configuration error to investigate.

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

### Reveal an application status enum

```yaml
reveal:
  - outputs.status
```

An application-level string such as `"approved"` would normally be tokenized. This rule keeps
`outputs.status` readable. It does not affect the corpus record's top-level `status`, which is a
structural enum and already passes by default.

### Drop an identifier whose linkage is sensitive

```yaml
drop:
  - inputs.patient_id
```

Tokenization would preserve whether the same patient appears in many traces. If that linkage is
itself sensitive, `drop` removes the field and the equality relationship with it. This is also
useful for high-cardinality identifiers that add no needed analytical signal.

### Narrow an over-broad reveal

```yaml
reveal:
  - inputs.**
tokenize:
  - inputs.auth.secret
```

Both rules match `inputs.auth.secret`, but the exact `tokenize` path is more specific than
`inputs.**`, so the secret is tokenized while other input strings remain revealed. If equally
specific rules conflict, the truth table above applies instead.

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

```yaml
time: shift
```

When `time: shift` is set, `start` and `end` timestamps are shifted by a single per-corpus constant
derived from the salt (ADR-0006). Ordering and every interval survive; absolute position doesn't.
Record counts and traffic volume remain visible. The default is `time: absolute` — timestamps pass
through unchanged.
