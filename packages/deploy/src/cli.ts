import { DeployError, renderDeployDiagnostic } from "./errors.js";
import {
  createDeployContext,
  type DeployCommandRun,
  type DeployContext,
  type DeployExitCode,
  type DeployIo,
  writeDiagnostic,
} from "./io.js";

export type DeployCommandName = "init" | "package" | "probe";

export interface RunDeployCliOptions {
  readonly argv?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly io?: Partial<DeployIo>;
  /** Replaces a command implementation; the default loads it on demand. */
  readonly commands?: Partial<Record<DeployCommandName, DeployCommandRun>>;
  readonly loadPackageVersion?: () => Promise<string>;
}

const helpText = `Usage:
  ai-engine-deploy init
  ai-engine-deploy package
  ai-engine-deploy probe --url <url> [--expect alive|ready] [--bearer-env NAME]
                         [--host-header HOST] [--timeout-ms N]
  ai-engine-deploy --help
  ai-engine-deploy --version
`;

// Nothing about a rejected argument is echoed, so a crafted argument can
// neither forge a diagnostic line nor reach a log.
const invalidUsageText = 'Invalid arguments. Run "ai-engine-deploy --help".\n';
const unexpectedFailureText = "The command could not be completed.\n";

const commandNames: readonly DeployCommandName[] = ["init", "package", "probe"];

function asRecord(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return value as Readonly<Record<string, unknown>>;
}

async function loadDefaultPackageVersion(): Promise<string> {
  const manifestUrl = new URL("../package.json", import.meta.url);
  const namespace = (await import(manifestUrl.href, {
    with: { type: "json" },
  })) as unknown;
  const version = asRecord(asRecord(namespace)?.default)?.version;
  if (typeof version !== "string" || version === "") {
    throw new Error("The package version is unreadable.");
  }
  return version;
}

// Each command is loaded only when it is selected, so usage output never pays
// for a module it will not run.
async function loadCommand(name: DeployCommandName): Promise<DeployCommandRun> {
  if (name === "init") return (await import("./init.js")).runInit;
  if (name === "package") {
    return (await import("./package-command.js")).runPackage;
  }
  return (await import("./probe.js")).runProbe;
}

function selectCommand(argument: string): DeployCommandName | undefined {
  return commandNames.find((name) => name === argument);
}

async function runSelectedCommand(
  name: DeployCommandName,
  args: readonly string[],
  context: DeployContext,
  options: RunDeployCliOptions,
): Promise<DeployExitCode> {
  try {
    const run = options.commands?.[name] ?? (await loadCommand(name));
    return await run(args, context);
  } catch (error) {
    if (error instanceof DeployError) {
      await writeDiagnostic(context, renderDeployDiagnostic(error));
      return error.exitCode;
    }
    await writeDiagnostic(context, unexpectedFailureText);
    return 2;
  }
}

/**
 * Dispatches one `ai-engine-deploy` invocation and resolves with its exit
 * code. Nothing is written to `stdout` except the usage and version output,
 * and the process status is never set here.
 */
export async function runDeployCli(
  options: RunDeployCliOptions = {},
): Promise<DeployExitCode> {
  const context = createDeployContext(options);
  const argv = options.argv ?? process.argv.slice(2);
  const [first, ...rest] = argv;

  if (first === "--help" || first === "--version") {
    if (rest.length > 0) {
      await writeDiagnostic(context, invalidUsageText);
      return 2;
    }
    try {
      const text =
        first === "--help"
          ? helpText
          : `${await (options.loadPackageVersion ?? loadDefaultPackageVersion)()}\n`;
      await context.io.writeStdout(text);
      return 0;
    } catch {
      await writeDiagnostic(context, unexpectedFailureText);
      return 2;
    }
  }

  const command = first === undefined ? undefined : selectCommand(first);
  if (command === undefined) {
    await writeDiagnostic(context, invalidUsageText);
    return 2;
  }
  return runSelectedCommand(command, rest, context, options);
}
