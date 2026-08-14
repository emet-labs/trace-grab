import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { CorpusRecord } from "../normalize/index.js";
import { buildManifest } from "./manifest.js";

export * from "./manifest.js";

/** Writes `corpus.jsonl` and `manifest.json` to `outDir`. No `policy.yaml` or `report.md` yet — issue #3 scope. */
export function writeBundle(outDir: string, records: CorpusRecord[]): void {
  mkdirSync(outDir, { recursive: true });

  const corpusText = records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : "");
  const corpusBytes = Buffer.from(corpusText, "utf8");
  writeFileSync(join(outDir, "corpus.jsonl"), corpusBytes);

  const manifest = buildManifest(records, corpusBytes);
  writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}
