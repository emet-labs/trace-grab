# ADR-0005 · Deny by default, preserve equality

**Status:** Decided. The load-bearing decision in this repo.

## Context

The campaign doc's sample output claims the tool removed *"12,911 customer names"*. Nothing
does that reliably. Regexes do not find names; entropy heuristics do not find names. NER would,
at maybe 95% accuracy — and 5% wrong across 38,000 fields is 1,900 leaked names. Any
detector-based design writes a check the implementation cannot cash, and the first partner whose
reviewer greps the corpus and finds a name the tool claimed to remove ends the program.

Meanwhile, runtime verification consumes **topology, ordering, tool identity, status, and
identity relationships between arguments**. Whether a value reads `alice@corp.com` or `TOK_a8f3`
is irrelevant to discovering that `modify_account(x)` requires a prior `authenticate(x)`.

## Decision

**Every string value is tokenized by default. Revealing plaintext is opt-in, per path.**

| Class | Default |
| --- | --- |
| String values (including ids, `error.message`, free text) | Tokenized |
| Numbers, booleans, timestamps, durations | Pass |
| `status`, `error.kind` | Pass |
| Attribute **keys** | Pass — keys are schema, not data, and are needed |
| `name`, `kind` (tool / span / run names) | **Pass verbatim** |
| Anything else in plaintext | Requires an explicit `reveal:` entry |

Values are **tokenized, not dropped**, so `x == y` still holds across the corpus. Equality is the
signal; content is not.

## The claim this buys

> [!IMPORTANT]
> By default we cannot read your data. We can only see that this field here holds the same value
> as that field there. If you want us to see a field's contents, you opt it in, and you will see
> it in the report before anything leaves.

That is true **by construction**. Detector-based redaction is true only if the regexes were good.

## Named exception

**Tool and span names pass verbatim.** A tool named `notify_bankruptcy_counsel` discloses
something. This is a deliberate trade — names are the vocabulary every candidate property is
expressed in — and it is stated plainly in `THREAT-MODEL.md` rather than hidden.

## Accepted cost

Error *messages* become opaque tokens, so "recurring failure patterns" degrades from clustering
on message text to clustering on error kind and shape. Mitigated by `error.kind` always passing
and `reveal: error.message` being the documented opt-in — which is conveniently the Tier 1 → Tier 2
gradient the program is already built on.

## Alternatives rejected

- **Allow by default with configured drops plus detectors** (what the doc describes). Richer
  corpora immediately and a more impressive first findings package — at the cost that a single
  unconfigured field leaks real data, and we learn about it from the partner rather than from a
  test.
- **Drop strings entirely instead of tokenizing.** Destroys the relational structure the campaign
  doc itself identifies as load-bearing, and with it the cross-system verification thesis of
  sentinel ADR-0016.

## Related

Detectors are not banned everywhere — they are correct on the **receiving** end as an alarm,
where a false negative costs nothing. See PRD §8 and issue #24.
