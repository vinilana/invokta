import {
  type CapabilityMap,
  type Engine,
  EngineError,
  type Principal,
} from "@ai-engine/core";

import { InvalidUtf8Error, readUtf8 } from "./stdin.js";

export interface CliIo {
  readonly readStdin: () => Promise<string>;
  readonly writeStdout: (text: string) => void | Promise<void>;
  readonly writeStderr: (text: string) => void | Promise<void>;
}

export interface RunCliOptions {
  readonly argv?: readonly string[];
  readonly principal: Principal | null;
  readonly signal?: AbortSignal;
  readonly format?: "json" | "human";
  readonly io?: Partial<CliIo>;
}

type CliCommand =
  | { readonly name: "list" }
  | { readonly name: "describe"; readonly capabilityId: string }
  | {
      readonly name: "run";
      readonly capabilityId: string;
      readonly input:
        | { readonly source: "argument"; readonly value: string }
        | {
            readonly source: "stdin";
          };
    };

const usage = `Usage:
  engine list
  engine describe <capability-id>
  engine run <capability-id> --input '<json>'
  engine run <capability-id> --stdin`;

class CliUsageError extends Error {
  readonly showUsage: boolean;

  constructor(message: string, showUsage = true) {
    super(message);
    this.name = "CliUsageError";
    this.showUsage = showUsage;
  }
}

class CliStdoutError extends Error {
  constructor(cause: unknown) {
    super("CLI stdout write failed.", { cause });
    this.name = "CliStdoutError";
  }
}

function parseCommand(argv: readonly string[]): CliCommand {
  const [command, ...args] = argv;
  if (command === "list" && args.length === 0) return { name: "list" };
  if (command === "describe" && args.length === 1 && args[0] !== "") {
    return { name: "describe", capabilityId: args[0] as string };
  }
  if (command !== "run" || args.length < 2 || args[0] === "") {
    throw new CliUsageError("Invalid command or arguments.");
  }

  const capabilityId = args[0] as string;
  const runArguments = args.slice(1);
  if (runArguments.length === 1 && runArguments[0] === "--stdin") {
    return { name: "run", capabilityId, input: { source: "stdin" } };
  }
  if (
    runArguments.length === 2 &&
    runArguments[0] === "--input" &&
    runArguments[1] !== undefined
  ) {
    return {
      name: "run",
      capabilityId,
      input: { source: "argument", value: runArguments[1] },
    };
  }
  throw new CliUsageError("Invalid command or arguments.");
}

async function readProcessStdin(): Promise<string> {
  return readUtf8(process.stdin);
}

const defaultIo: CliIo = {
  readStdin: readProcessStdin,
  writeStdout: (text) => {
    process.stdout.write(text);
  },
  writeStderr: (text) => {
    process.stderr.write(text);
  },
};

function resolveIo(overrides: Partial<CliIo> | undefined): CliIo {
  return {
    readStdin: overrides?.readStdin ?? defaultIo.readStdin,
    writeStdout: overrides?.writeStdout ?? defaultIo.writeStdout,
    writeStderr: overrides?.writeStderr ?? defaultIo.writeStderr,
  };
}

function parseInput(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    throw new CliUsageError("Input must be valid JSON.", false);
  }
}

function serialize(value: unknown, format: "json" | "human" = "json"): string {
  return `${JSON.stringify(value, null, format === "human" ? 2 : undefined)}\n`;
}

const genericExecutionError =
  '{"error":{"code":"EXECUTION_FAILED","message":"CLI execution failed."}}\n';

function renderEngineError(error: EngineError): string {
  let code: unknown;
  let message: unknown;
  try {
    code = error.code;
    message = error.message;
  } catch {
    return genericExecutionError;
  }
  if (typeof code !== "string" || typeof message !== "string") {
    return genericExecutionError;
  }

  const safeError = { code, message };
  let publicDetails: unknown;
  try {
    publicDetails = error.publicDetails;
  } catch {
    return serialize({ error: safeError });
  }

  try {
    return serialize({
      error: {
        ...safeError,
        ...(publicDetails === undefined ? {} : { publicDetails }),
      },
    });
  } catch {
    return serialize({ error: safeError });
  }
}

function renderUsageError(error: CliUsageError): string {
  return serialize({
    error: {
      code: "INVALID_USAGE",
      message: error.showUsage ? `${error.message}\n\n${usage}` : error.message,
    },
  });
}

type CapabilityId<Capabilities extends CapabilityMap> = Extract<
  keyof Capabilities,
  string
>;

async function writeStdout(io: CliIo, text: string): Promise<void> {
  try {
    await io.writeStdout(text);
  } catch (cause) {
    throw new CliStdoutError(cause);
  }
}

async function writeStderr(io: CliIo, text: string): Promise<void> {
  try {
    await io.writeStderr(text);
  } catch {
    // A diagnostic destination cannot change the command's numeric result.
  }
}

async function execute<Capabilities extends CapabilityMap>(
  engine: Engine<Capabilities>,
  command: CliCommand,
  options: RunCliOptions,
  io: CliIo,
): Promise<void> {
  if (command.name === "list") {
    await writeStdout(io, serialize(engine.list(), options.format));
    return;
  }
  const capabilityId = command.capabilityId as CapabilityId<Capabilities>;
  if (command.name === "describe") {
    await writeStdout(
      io,
      serialize(engine.describe(capabilityId), options.format),
    );
    return;
  }

  const encodedInput =
    command.input.source === "stdin"
      ? await io.readStdin()
      : command.input.value;
  const input = parseInput(encodedInput);
  const result = await engine.invoke(capabilityId, input as never, {
    source: "cli",
    principal: options.principal,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  await writeStdout(io, serialize(result, options.format));
}

export async function runCli<Capabilities extends CapabilityMap>(
  engine: Engine<Capabilities>,
  options: RunCliOptions,
): Promise<number> {
  const io = resolveIo(options.io);
  let exitCode: number;
  try {
    if (!Object.hasOwn(options, "principal")) {
      throw new CliUsageError(
        "The trusted principal option is required.",
        false,
      );
    }
    const command = parseCommand(options.argv ?? process.argv.slice(2));
    await execute(engine, command, options, io);
    exitCode = 0;
  } catch (error) {
    if (error instanceof CliUsageError) {
      await writeStderr(io, renderUsageError(error));
      exitCode = 2;
    } else if (error instanceof InvalidUtf8Error) {
      await writeStderr(
        io,
        renderUsageError(new CliUsageError(error.message, false)),
      );
      exitCode = 2;
    } else if (error instanceof EngineError) {
      await writeStderr(io, renderEngineError(error));
      exitCode = 1;
    } else {
      await writeStderr(
        io,
        serialize({
          error: {
            code: "EXECUTION_FAILED",
            message: "CLI execution failed.",
          },
        }),
      );
      exitCode = 1;
    }
  }
  return exitCode;
}
