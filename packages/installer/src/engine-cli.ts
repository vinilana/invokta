import {
  executeInteractiveCliCommand,
  type InstallerCliIo,
  type InstallerCommand,
  type InstallerExitCode,
  resolveInstallerCliIo,
  writeInitializationFailure,
} from "./run-installer-cli.js";

export type { InstallerCliIo, InstallerExitCode } from "./run-installer-cli.js";

export interface RunEngineInstallerCliOptions {
  /** Absolute directory holding the embedding engine's `invokta.mcp.json`. */
  readonly packageRoot: string;
  /** Executable name rendered in help and usage diagnostics. */
  readonly binaryName: string;
  readonly argv?: readonly string[];
  readonly io?: Partial<InstallerCliIo>;
  readonly loadInteractiveSession?: (
    command: InstallerCommand,
  ) => Promise<InstallerExitCode>;
}

function helpText(binaryName: string): string {
  return `Usage:
  ${binaryName} install
  ${binaryName} uninstall
  ${binaryName} --help
`;
}

function parseEngineCommand(
  argv: readonly string[],
  packageRoot: string,
): InstallerCommand | undefined {
  if (argv.length !== 1) return undefined;
  if (argv[0] === "install") {
    return Object.freeze({
      kind: "install-engine",
      projectDirectory: packageRoot,
    });
  }
  if (argv[0] === "uninstall") {
    return Object.freeze({
      kind: "remove-engine",
      projectDirectory: packageRoot,
    });
  }
  return undefined;
}

async function writeUsageFailure(
  io: InstallerCliIo,
  binaryName: string,
): Promise<2> {
  try {
    await io.writeStderr(`Invalid arguments. Run "${binaryName} --help".\n`);
  } catch {
    // A broken diagnostic destination cannot change the selected exit code.
  }
  return 2;
}

export async function runEngineInstallerCli(
  options: RunEngineInstallerCliOptions,
): Promise<InstallerExitCode> {
  const io = resolveInstallerCliIo(options.io);
  const argv = options.argv ?? process.argv.slice(2);

  if (argv.length === 1 && argv[0] === "--help") {
    try {
      await io.writeStdout(helpText(options.binaryName));
      return 0;
    } catch (error) {
      return writeInitializationFailure(io, error);
    }
  }
  const command = parseEngineCommand(argv, options.packageRoot);
  if (command === undefined) {
    return writeUsageFailure(io, options.binaryName);
  }

  return executeInteractiveCliCommand({
    command,
    io,
    ...(options.loadInteractiveSession === undefined
      ? {}
      : { loadInteractiveSession: options.loadInteractiveSession }),
  });
}
