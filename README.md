# trace-grab

`trace-grab` reads trace exports you already have, tokenizes every string value, and writes a
bundle to **your** disk. It has no server, no account, and no upload step. Nothing leaves your
environment unless you send it yourself.

For what the tool protects against — and explicitly what it does not — read
[`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md). The notes below are checkable, not reassuring.

## What it does

Reads a trace export on your machine, normalizes it to span-shaped records, replaces every string
value with a stable token derived from a secret salt that stays on your machine, and writes a
bundle — `corpus.jsonl`, `manifest.json`, `policy.yaml`, `report.md` — to a directory you name.
One pass, no network, no prompts:

```sh
npx @emetlabs/trace-grab grab ./langsmith-export --out ./corpus
```

The `grab` and `check` verbs work today on file exports (LangSmith export, OTLP JSON, plain
span-shaped JSONL). The LangSmith API fetcher — the only networked module — is the remaining piece
([#13](https://github.com/emet-labs/trace-grab/issues/13)).

## What it does not do

Each claim is something to verify, not a promise.

| Claim | Verify |
| --- | --- |
| Never contacts an Emet endpoint — there is none in the source | `grep -ri emet src/` prints nothing |
| No telemetry, analytics, or update check | `grep -riE "telemetry\|analytics\|update.?check" src/` prints nothing |
| No `postinstall` script | `jq '.scripts.postinstall // "absent"' package.json` → `"absent"` |
| One runtime dependency | `jq '.dependencies \| length' package.json` → `1` |
| No network primitive outside the single fetcher module | `bun test test/no-egress.test.ts` |
| No Bun-specific API in shipped `src/` — runs under plain Node ≥ 20 | `bun test test/no-egress.test.ts` |
| The corpus leaves your machine only when you send it | there is no upload command; see *Transfer* below |

The published package carries SLSA provenance — a build attestation tying the tarball to a commit and
a workflow run in this repo, signed via sigstore. Verify the "Provenance" badge on the
[npm package page](https://www.npmjs.com/package/@emetlabs/trace-grab) or the entry in the
[sigstore transparency log](https://search.sigstore.dev). Publishing uses GitHub OIDC trusted
publishing — no npm access token is stored or used, so there is no secret to rotate or leak.

## Deny by default, equality preserved

The default is not "we remove the sensitive bits." The default is **we keep none of your string
content at all.** Every string value becomes a stable token. Numbers, booleans, timestamps,
durations, and status codes pass through. Field *names* pass through. Values do not.

```jsonc
// before
{ "name": "modify_account", "inputs": { "account": "acct_1208", "actor": "alice@corp.com" } }

// after
{ "name": "modify_account", "inputs": { "account": "TOK_4f1ab9c072", "actor": "TOK_88b0e13a5d" } }
```

The same value always produces the same token, everywhere in the corpus. That is the entire point:
it preserves the fact that *this account here is the same account there* — which is what makes the
traces analytically useful — while carrying none of the underlying values. Equality is preserved;
identity is not.

To let a specific field through in plaintext, name it in `tracegrab.yaml`:

```yaml
reveal:
  - outputs.status
  - inputs.currency
drop:
  - inputs.patient_id     # remove entirely — even the linkage is sensitive
time: shift               # preserve all intervals, destroy absolute timestamps
```

Zero configuration is a valid configuration. With no `tracegrab.yaml` at all, you get the safe
default. The four dispositions — `reveal`, `drop`, `time`, and the tokenized default — and the full
precedence table live in [`docs/POLICY.md`](docs/POLICY.md).

## The named exception: tool and span names pass verbatim

Tool and span names, span kind, status, and `error.kind` pass through in plaintext. They are the
vocabulary any analysis is written in, and they are also a disclosure class: a span named
`notify_bankruptcy_counsel` says something on its own. That is a deliberate, named exception — see
[`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) — not a leak. If a name is itself sensitive, `drop`
the field.

## Your salt and your keymap

On first run the tool writes `.trace-grab/salt` (mode `0600`). Two things depend on it:

- **Reading results back.** `.trace-grab/keymap.jsonl` maps tokens back to your original values so a
  token in an analysis result means something to you. It is never part of the bundle. Use
  `--no-keymap` to skip it.
- **Consistency across batches.** The same salt produces the same tokens next month.

> [!WARNING]
> Keep the salt. If you lose it between batches, the second corpus looks completely fine and
> correlates with the first not at all — there is no error to notice. The keymap is a
> re-identification file on your own disk; protect it accordingly.

## Sources

| Source | How |
| --- | --- |
| Files you exported yourself (LangSmith export, OTLP JSON, plain span-shaped JSONL) | `grab ./dir` — no credentials involved |
| LangSmith API | `grab --from langsmith-api <project>`, reads `LANGSMITH_API_KEY` from the environment — forthcoming ([#13](https://github.com/emet-labs/trace-grab/issues/13)) |

The file path is the recommended one. It needs no credentials, works offline, and the tool cannot
have read anything beyond the files you handed it.

## Transfer

There is no upload command. When you're ready:

```sh
tar -czf corpus.tar.gz ./corpus
curl -T corpus.tar.gz "<the URL we gave you>"
```

Or send it however your company prefers. The corpus is a directory of files on your disk; nothing
about it requires our infrastructure.

## Pseudonymization is not anonymization

Stable tokens are pseudonyms. Pseudonymization is not anonymization under UK GDPR / ICO guidance:
where re-identification is possible from separately held information, pseudonymized data remains
personal data. This tool produces pseudonymized, de-identified traces. It does not produce "fully
anonymized" traces, and the README and the tool's output never claim to. The keymap on your disk is
the re-identification key.

## CI enforces zero egress

Every pull request runs [`test/no-egress.test.ts`](test/no-egress.test.ts), which fails the build
if any file under `src/` references an Emet-owned domain outside the package scope, if a network
primitive (`fetch`, `node:http`, `node:https`, `node:net`, `WebSocket`) appears outside the single
fetcher module, or if a Bun-specific API leaks into `src/`. The canary suite
([`test/canary.test.ts`](test/canary.test.ts)) proves the deny-by-default invariant — that no
plaintext string value survives outside the named pass-verbatim fields — and the metamorphic suite
([`test/metamorphic.test.ts`](test/metamorphic.test.ts)) proves equality, topology, determinism,
idempotence, and salt sensitivity.

## If the configuration leaks something

Deny-by-default means the only way plaintext reaches the bundle is a field you named in `reveal:` —
that is the leak surface. It is also silent: a misspelled path matches nothing, and an over-broad
one produces a run that looks correct. So this is the committed sequence for when that happens,
written before the first corpus, not after ([#23](https://github.com/emet-labs/trace-grab/issues/23)).

1. **Quarantine on detection.** The affected batch is moved out of the analysis path immediately.
   No new derived artifacts are produced from it while it is under review.
2. **Notify within one business day.** We tell you what we found and where: which field, which
   disposition rule let it through, and in how many records.
3. **Delete on request.** Your call, no questions. The batch is removed and you get written
   confirmation.
4. **No propagation into derived artifacts.** Deletion is not just the corpus file. Any candidate
   property the batch fed is not promoted; aggregates and findings retained after deletion are purged.
5. **Ownership by role.** One role owns the technical steps; another owns the partner-facing steps;
   counsel reviews both. By role, not name.

## License

Apache-2.0.

---

Designing or contributing? The rationale lives in [`docs/`](docs/) and the work is tracked in
[Issues](https://github.com/emet-labs/trace-grab/issues).
