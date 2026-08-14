# Contributing

## Setup

```
bun install
bun run build
```

Development runs on Bun. Distribution is plain Node-compatible ESM — see
[ADR-0003](docs/adr/0003-bun-for-development-node-for-distribution.md). Bun-only APIs
(`Bun.file`, `Bun.write`, `Bun.serve`, `bun:sqlite`, ...) are banned from `src/`.

## Dependencies

`trace-grab` ships with exactly one runtime dependency: `yaml`. That's load-bearing — see
[ADR-0001](docs/adr/0001-contributor-side-only-and-open-source.md) and
[ADR-0007](docs/adr/0007-zero-emet-egress.md). A reviewer deciding whether to trust this tool
with production traces is expected to read every dependency; each one added is a cost paid by
every future reviewer, not just this PR.

**Adding a second runtime dependency requires an ADR.** Open one before the PR, not alongside
it — the decision needs to survive independent of whether the code review passes.

Dev dependencies (`typescript`, `@types/node`, test tooling) aren't covered by this rule.

## No `postinstall`

Never add a `postinstall` script. It's the first thing a security reviewer greps for when
deciding whether to run `npm install` on this package at all.
