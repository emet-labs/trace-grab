# Threat model

`trace-grab` reduces the amount of readable trace content in a corpus before that corpus leaves
the contributor's environment. It does not make a trace corpus harmless, anonymous, or safe for
unrestricted distribution.

## Scope and trust boundary

The contributor controls the source export, the machine running the CLI, `tracegrab.yaml`, the
salt, the keymap, the output directory, and the decision to transfer the bundle. `trace-grab`
sends nothing to Emet; any transfer is a separate action performed by the contributor.

File sources are read locally. The opt-in LangSmith API source contacts only the configured
LangSmith base URL to fetch records; it does not upload a corpus. `trace-grab` has no Emet upload
endpoint, telemetry, analytics, or error-reporting service.

This model assumes the machine and operator are trustworthy while the tool runs. The source data
and policy can contain mistakes, but they are not assumed to be actively malicious.

## What the tool protects against

With no policy, string values outside the documented pass-verbatim fields are replaced by stable
`TOK_…` pseudonyms before the bundle is written. A string is readable in the bundle only when it
belongs to one of those fields or a matching `reveal` rule. `drop` removes an optional field,
including its linkage; required fields cannot be removed and fail closed as described in
[`docs/POLICY.md`](docs/POLICY.md). The generated report lists observed paths and plaintext
dispositions so the contributor can inspect the result before transfer.

These controls reduce accidental disclosure of string content that the contributor did not
choose to reveal. They do not inspect whether a value "looks sensitive," classify personal data,
or prove that a configured policy is appropriate.

## Information that remains visible

The bundle deliberately retains structure needed for analysis:

- **Tool, span, and run names pass verbatim.** A name such as
  `notify_bankruptcy_counsel` can disclose sensitive business or personal context on its own.
  Span kind, status, `error.kind`, and source vendor also pass.
- **Object keys and native label keys pass verbatim.** Input, output, attribute, and unmapped-field
  names reveal the application's schema, while label keys reveal its annotation vocabulary, even
  when associated values are tokenized or dropped.
- **Linkage survives tokenization.** Equal source strings receive equal tokens. Trace topology,
  parent/child relationships, links, ordering, and repeated-value frequency remain visible. This
  is the analytical purpose of tokenization and also a disclosure class. For optional fields, use
  `drop` when the relationship itself must not survive.
- **Numbers and booleans pass by default.** They can carry sensitive meaning even though they are
  not string content. A policy can drop optional fields that contain them.
- **Timing and volume remain observable.** With the default `time: absolute`, absolute timestamps,
  intervals, ordering, and record counts are visible. `time: shift` removes absolute position but
  preserves intervals and ordering. It does not hide traffic volume.
- **Explicit reveals are plaintext.** A `reveal` rule is an instruction to include matching values,
  not a hint that the tool may override.

Stable tokens can also support inference from repetition, surrounding structure, timing, volume,
or outside knowledge. Tokenization is not encryption of the corpus and does not claim to prevent
such inference.

## Salt and keymap

The salt keeps token assignment stable across batches. The optional
`.trace-grab/keymap.jsonl` maps tokens back to their original values so the contributor can
interpret findings. It is a re-identification file stored on the contributor's disk with mode
`0600`; the CLI does not include it in the bundle. `--no-keymap` prevents its creation.

Anyone who obtains the keymap can recover every value recorded there. Protect it separately from
the transferred corpus. The tool does not manage backups, access control beyond local file mode,
retention, or deletion of the contributor's local files.

## Pseudonymization is not anonymization

The output can be described operationally as sanitized, de-identified, or pseudonymized. None of
those words means that `trace-grab` produces anonymous information. Stable pseudonyms can remain
personal data when a person can be identified using the separately held keymap, the source data,
or other information.

The UK Information Commissioner's Office states that pseudonymized personal data remains within
data-protection law for a party that holds the additional identifying information; it describes
pseudonymization as a risk-reduction and security measure, not a way to make the law stop applying.
See the ICO's current [pseudonymisation guidance](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/data-sharing/anonymisation/pseudonymisation/).

Whether a particular corpus is personal data for a particular recipient depends on context and
available additional information. `trace-grab` does not make that legal determination and never
claims to produce "fully anonymized" data.

## Threats this tool does not address

`trace-grab` does not defend against:

- a compromised machine, runtime, dependency, shell, filesystem, or user account;
- an operator who deliberately reveals or transfers sensitive fields;
- a mistaken, over-broad, or malicious policy;
- access to the original export, salt, keymap, API credential, or other local files;
- re-identification or inference using visible names, keys, topology, linkage, timing, volume, or
  outside information;
- denial-of-service inputs, resource exhaustion, or an unavailable source API;
- false, incomplete, or misleading source telemetry; or
- tampering after generation. The manifest's digest detects corpus changes when checked against a
  trusted manifest, but the manifest is not a signature and does not establish authorship.

The tool also does not upload, approve, retain, or delete a transferred corpus on anyone else's
behalf. Those are operational and governance responsibilities outside this CLI.
