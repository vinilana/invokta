import {
  InstallerError,
  renderInstallerDiagnostic,
} from "@invokta/installer-core/errors";

export type ManagerExitCode = 0 | 1 | 2;

export interface ManagerOptions {
  readonly port: number;
  readonly scanRoots: readonly string[];
  readonly open: boolean;
}

export type ManagerCommand =
  | { readonly kind: "start"; readonly options: ManagerOptions }
  | { readonly kind: "help" }
  | { readonly kind: "version" };

export const helpText = `Usage:
  invokta-manager [--port <number>] [--scan <directory>]... [--no-open]
  invokta-manager --help
  invokta-manager --version

Options:
  --port <number>     Listen on a fixed loopback port instead of an ephemeral one.
  --scan <directory>  Add a directory to the Action Engine project scan. Repeatable.
  --no-open           Print the console URL instead of opening a browser.
`;

export const invalidUsageText =
  'Invalid arguments. Run "invokta-manager --help".\n';

export interface ManagerCliIo {
  readonly writeStdout: (text: string) => void | Promise<void>;
  readonly writeStderr: (text: string) => void | Promise<void>;
}

export interface RunManagerCliOptions {
  readonly argv?: readonly string[];
  readonly io?: Partial<ManagerCliIo>;
  readonly loadConsole?: (options: ManagerOptions) => Promise<ManagerExitCode>;
  readonly loadPackageVersion?: () => Promise<string>;
}

/**
 * Pure argument parsing, kept separate so the accepted grammar can be proven
 * without starting a server or touching the filesystem.
 */
export function parseManagerArguments(
  argv: readonly string[],
): ManagerCommand | undefined {
  if (argv.length === 1 && argv[0] === "--help") return { kind: "help" };
  if (argv.length === 1 && argv[0] === "--version") return { kind: "version" };

  let port = 0;
  let portSeen = false;
  let open = true;
  const scanRoots: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--no-open") {
      if (!open) return undefined;
      open = false;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) return undefined;
    if (flag === "--port") {
      if (portSeen) return undefined;
      if (!/^\d{1,5}$/u.test(value)) return undefined;
      const parsed = Number.parseInt(value, 10);
      if (parsed < 1 || parsed > 65_535) return undefined;
      port = parsed;
      portSeen = true;
    } else if (flag === "--scan") {
      scanRoots.push(value);
    } else {
      return undefined;
    }
    index += 1;
  }

  return {
    kind: "start",
    options: Object.freeze({
      port,
      scanRoots: Object.freeze(scanRoots),
      open,
    }),
  };
}

const defaultIo: ManagerCliIo = {
  writeStdout: (text) => {
    process.stdout.write(text);
  },
  writeStderr: (text) => {
    process.stderr.write(text);
  },
};

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
    throw new InstallerError("INSTALLER_INITIALIZATION_FAILED");
  }
  return version;
}

async function loadDefaultConsole(
  options: ManagerOptions,
): Promise<ManagerExitCode> {
  const { startConsole } = await import("./start-console.js");
  return startConsole(options);
}

export async function runManagerCli(
  options: RunManagerCliOptions = {},
): Promise<ManagerExitCode> {
  const io = {
    writeStdout: options.io?.writeStdout ?? defaultIo.writeStdout,
    writeStderr: options.io?.writeStderr ?? defaultIo.writeStderr,
  };
  const command = parseManagerArguments(options.argv ?? process.argv.slice(2));
  if (command === undefined) {
    await io.writeStderr(invalidUsageText);
    return 2;
  }
  try {
    if (command.kind === "help") {
      await io.writeStdout(helpText);
      return 0;
    }
    if (command.kind === "version") {
      const version = await (
        options.loadPackageVersion ?? loadDefaultPackageVersion
      )();
      await io.writeStdout(`${version}\n`);
      return 0;
    }
    return await (options.loadConsole ?? loadDefaultConsole)(command.options);
  } catch (error) {
    const installerError =
      error instanceof InstallerError
        ? error
        : new InstallerError("INSTALLER_INITIALIZATION_FAILED", error);
    try {
      await io.writeStderr(renderInstallerDiagnostic(installerError));
    } catch {
      // A broken diagnostic destination cannot change the selected exit code.
    }
    return installerError.code === "INSTALLER_INITIALIZATION_FAILED" ? 2 : 1;
  }
}
