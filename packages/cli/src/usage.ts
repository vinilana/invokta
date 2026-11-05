export const usage = `Usage:
  engine list
  engine describe <capability-id>
  engine run <capability-id> --input '<json>'
  engine run <capability-id> --stdin
  engine run <capability-id> --<flag> <value> ...
  engine run <capability-id> --help
  engine help [<capability-id>]`;

export const generalHelp = `${usage}

Commands:
  list      Print capability summaries as JSON.
  describe  Print one capability contract as JSON.
  run       Invoke one capability with exactly one input source.
  help      Print this help, or the flags of one capability.

Run "engine help <capability-id>" to list the flags derived from a
capability's input schema.
`;

export class CliUsageError extends Error {
  readonly showUsage: boolean;

  constructor(message: string, showUsage = true) {
    super(message);
    this.name = "CliUsageError";
    this.showUsage = showUsage;
  }
}
