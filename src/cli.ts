#!/usr/bin/env node

const USAGE = `Usage: trace-grab <command> [options]

Commands:
  grab <input>          Read, normalize, sanitize, and write a bundle
  check --value <v>     Locate a value's token in a bundle

Run 'trace-grab <command> --help' for command-specific options.`;

function main(argv: string[]): void {
  const [command] = argv;

  switch (command) {
    case "grab":
    case "check":
      throw new Error(`'${command}' is not yet implemented`);
    default:
      console.log(USAGE);
      process.exitCode = command === undefined ? 0 : 1;
  }
}

main(process.argv.slice(2));
