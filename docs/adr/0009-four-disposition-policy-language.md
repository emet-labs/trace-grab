# ADR-0009 · Four dispositions, dotted paths, YAML

**Status:** Decided. Implements [ADR-0005](0005-deny-by-default-equality-preserving-tokenization.md).

## Decision

Deny-by-default means most partners need **no configuration at all** — `trace-grab grab ./export`
with zero setup must produce a valid, safe bundle. `tracegrab.yaml` is optional and exists only
to move fields in the two directions people actually need.

### Dispositions

| Disposition | Meaning |
| --- | --- |
| `reveal:` | Pass verbatim. The opt-in escape from tokenization. **This list is the leak surface** and gets top billing in the report. |
| `tokenize:` | The default for strings; appears in config only to narrow an over-broad `reveal`. |
| `drop:` | Remove the field entirely. |
| typed passthrough | Numbers, booleans, timestamps pass by default — but must be droppable. |

### Why `drop` is distinct from `tokenize`

Sometimes the **equality relation itself** is the disclosure. A tokenized `patient_id` still
reveals that the same patient appears in forty traces, which reconstructs a care journey without
ever revealing a name. Tokenizing preserves linkage; linkage is sometimes exactly what must not
survive.

### Precedence

`drop` beats `reveal` beats default. Most-specific path wins; on a tie, the more restrictive
disposition wins. Failing closed is the only acceptable ambiguity resolution in a security config.

### Path syntax

Dotted paths over the nested record. `*` matches one segment, `**` matches any depth, array
elements collapse to `[*]` — `inputs.items[*].sku`. **The policy, the inventory, and the report
all speak this same language**, so what a partner approves in the report is literally what the
policy matched.

## Two safety features that are not optional

**Unmatched-path warnings.** If the policy says `drop: inputs.ssn` and that path never occurred,
the report says so loudly. This is the classic redaction failure — a rule written against a
half-remembered field name, silently matching nothing, shipped in the belief that it protected
something. Surfacing it costs nothing and catches the highest-consequence configuration error
available.

**Unknown top-level keys are a hard error**, not a warning. A typo'd key in a security config must
never fail open.

## Timestamp handling

`time: absolute` (default) or `time: shift` — a single constant per-corpus offset that preserves
every interval and all ordering while destroying absolute position. Absolute timestamps leak
business volume, working hours, and incident timing, and aid re-identification against public
events. Most partners will not care; the ones who do get a meaningful concession that costs five
lines and no analytical fidelity. The offset derives from the salt
([ADR-0006](0006-persistent-salt-and-local-keymap.md)) so it is stable across batches.

## Format

**YAML**, `tracegrab.yaml`, committed to the partner's own repo, and copied verbatim into every
bundle so each corpus is self-describing about what was stripped.

Rejected: JS/TS config. An executable config file is both audit surface and unreadable to the
security or legal reviewer who has to approve it — and this file will be read by non-engineers.
