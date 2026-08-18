#!/usr/bin/env node

import { writeBundle } from "./bundle/index.js";
import { loadOrCreateSalt, sanitizeRecord } from "./sanitize/index.js";
import { readGenericJsonl } from "./sources/index.js";

const USAGE = `Usage: trace-grab <command> [options]

Commands:
  grab <input> --out <dir>   Read, normalize, sanitize, and write a bundle
  check --value <v>          Locate a value's token in a bundle

Run 'trace-grab <command> --help' for command-specific options.`;

function parseFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

async function grab(args: string[]): Promise<void> {
  const [input] = args;
  const out = parseFlag(args, "--out");
  if (!input || !out) {
    console.error("Usage: trace-grab grab <input> --out <dir>");
    process.exitCode = 1;
    return;
  }

  const rawRecords = readGenericJsonl(input);
  const salt = loadOrCreateSalt();
  const corpusRecords = rawRecords.map((record) => sanitizeRecord(record, salt));
  await writeBundle(out, corpusRecords);

  console.log(`Wrote ${corpusRecords.length} record(s) to ${out}`);
}

function main(argv: string[]): void {
  const [command, ...rest] = argv;

  switch (command) {
    case "grab":
      void grab(rest).catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
      return;
    case "check":
      throw new Error(`'${command}' is not yet implemented`);
    default:
      console.log(USAGE);
      process.exitCode = command === undefined ? 0 : 1;
  }
}

main(process.argv.slice(2));
