# trace-grab

Sanitize your agent execution traces on your own machine, look at exactly what came out, then
share it — or don't.

`trace-grab` reads trace exports you already have, strips their content, and writes a bundle to
your disk. It has no server, no account, and no upload step. Nothing leaves your environment
unless you send it yourself.

> [!NOTE]
> **Not implemented yet.** The design is settled and this describes the tool being built. Commands
> below do not work today.

## How it works

```
your export  ──▶  parse  ──▶  normalize  ──▶  sanitize  ──▶  ./corpus/
(files you                                                    corpus.jsonl
 already have)                                                manifest.json
                                                              policy.yaml
                                                              report.md
```

One pass, no network, no prompts:

```sh
npx @emet/trace-grab grab ./langsmith-export --out ./corpus
```

### Everything is tokenized unless you say otherwise

The default is not "we remove the sensitive bits." The default is **we keep none of your string
content at all.**

Every string value is replaced by a stable token derived from a secret salt that stays on your
machine. Numbers, booleans, timestamps, durations, and status codes pass through. Field *names*
pass through. Values do not.

```jsonc
// before
{ "tool": "modify_account", "inputs": { "account": "acct_1208", "actor": "alice@corp.com" } }

// after
{ "tool": "modify_account", "inputs": { "account": "TOK_4f1ab9c072", "actor": "TOK_88b0e13a5d" } }
```

The same value always produces the same token, everywhere in the corpus. That is the entire point:
it preserves the fact that *this account here is the same account there* — which is what makes the
traces analytically useful — while carrying none of the underlying values.

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
default.

### What you can see before deciding anything

`report.md` in the bundle opens with the complete list of every field that left in plaintext —
not a sample, the whole list. It also flags policy rules that matched nothing, which is the usual
way a redaction config silently fails.

To test a specific value yourself:

```sh
npx @emet/trace-grab check --value "alice@corp.com" ./corpus
# appears as TOK_88b0e13a5d in 412 records; never appears in plaintext
```

### Your salt and your keymap

On first run the tool writes `.trace-grab/salt` (mode `0600`). Two things depend on it:

- **Reading results back.** `.trace-grab/keymap.jsonl` maps tokens to your original values so a
  token in an analysis result means something to you. It is never part of the bundle. Use
  `--no-keymap` to skip it.
- **Consistency across batches.** The same salt produces the same tokens next month.

> [!WARNING]
> Keep the salt. If you lose it between batches, the second corpus looks completely fine and
> correlates with the first not at all — there is no error to notice.

## Sources

| Source | How |
| --- | --- |
| Files you exported yourself (LangSmith, Braintrust, OTLP JSON, plain JSONL) | `grab ./dir` — no credentials involved |
| LangSmith API | `grab --from langsmith-api <project>`, reads `LANGSMITH_API_KEY` from the environment |

The file path is the recommended one. It needs no credentials, works offline, and the tool cannot
have read anything beyond the files you handed it.

## What it does not do

Each of these is checkable, not a promise:

| | Check it |
| --- | --- |
| Never contacts us — there is no endpoint for it in the source | `grep -ri emet src/` |
| No telemetry, no analytics, no update check, no `postinstall` | `cat package.json` |
| One runtime dependency | `npm ls --omit=dev` |
| Network calls exist in exactly one file, and only to your vendor | `src/sources/langsmith-api.ts`; CI fails if that changes |
| The published package is built from this repo | `npm audit signatures` |

## CI enforces zero egress

Every pull request runs [`test/no-egress.test.ts`](test/no-egress.test.ts), which fails the build
if any file under `src/` references an Emet-owned domain outside the package scope, if a network
primitive (`fetch`, `node:http`, `node:https`, `node:net`, `WebSocket`) appears outside the single
fetcher module, or if a Bun-specific API leaks into `src/`. A second job builds the package, runs
`npm pack`, installs the tarball into a scratch directory, and smoke-tests `trace-grab grab` under
Node 20 and Node 22 — so the published shape is the one CI proved runnable under plain Node.

## Sending a corpus

There is no upload command. When you're ready:

```sh
tar -czf corpus.tar.gz ./corpus
curl -T corpus.tar.gz "<the URL we gave you>"
```

Or send it however your company prefers.

## If the configuration leaks something

Deny-by-default means the only way plaintext reaches the bundle is a field you named in `reveal:` — that is the leak surface ([ADR-0009](docs/adr/0009-four-disposition-policy-language.md)). It is also silent: a misspelled path matches nothing, and an over-broad one produces a run that looks correct ([ADR-0014](docs/adr/0014-corpus-data-is-a-distinct-class.md)). So this is the committed sequence for when that happens, written before the first corpus, not after.

1. **Quarantine on detection.** The affected batch is moved out of the analysis path immediately. No new derived artifacts — mined candidate properties, aggregates, findings — are produced from it while it is under review.
2. **Notify within one business day.** We tell you what we found and where: which field, which disposition rule let it through, and in how many records.
3. **Delete on request.** Your call, no questions. The batch is removed and you get written confirmation, tied to the data-use agreement's deletable-on-request default.
4. **No propagation into derived artifacts.** Deletion is not just the corpus file. Any candidate property the batch fed is not promoted to a real Specification; aggregates and findings retained after deletion are purged. This is the step that catches a leak a naive cleanup misses.
5. **Ownership by role.** One role owns the technical steps — quarantine, deletion, derived-artifact audit; another owns the partner-facing steps — notification and written confirmation; counsel reviews both. By role, not name.

Kept consistent with the retention and permitted-uses terms it operates under, and reviewed by counsel alongside the data-use agreement.

## Limits worth knowing

- **Tool and span names pass through verbatim.** They are the vocabulary any analysis is written
  in. A tool named `notify_bankruptcy_counsel` tells us something.
- **Field names pass through verbatim.** Your schema is visible even when your values are not.
- **Tokenization is pseudonymization, not anonymization.** Stable pseudonyms can remain personal
  data under UK GDPR where re-identification is possible from separately held information.
- **Linkage survives by design.** A tokenized identifier still shows that the same entity appears
  across forty traces. `drop` is the mitigation where that matters.

## License

Apache-2.0.

---

Designing or contributing? The rationale lives in [`docs/`](docs/) and the work is tracked in
[Issues](https://github.com/emet-labs/trace-grab/issues).
