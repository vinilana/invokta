import {
  InstallerError,
  renderInstallerDiagnostic,
} from "./installer-error.js";

export type InstallerExitCode = 0 | 1 | 2 | 130;

export interface InstallerCliIo {
  readonly inputIsTTY: () => boolean;
  readonly outputIsTTY: () => boolean;
  readonly writeStdout: (text: string) => void | Promise<void>;
  readonly writeStderr: (text: string) => void | Promise<void>;
}

export interface RunInstallerCliOptions {
  readonly argv?: readonly string[];
  readonly io?: Partial<InstallerCliIo>;
  readonly loadInteractiveSession?: () => Promise<InstallerExitCode>;
  readonly loadPackageVersion?: () => Promise<string>;
}

const helpText = `Usage:
  invokta-installer
  invokta-installer --help
  invokta-installer --version
`;

const invalidUsageText = 'Invalid arguments. Run "invokta-installer --help".\n';

const defaultIo: InstallerCliIo = {
  inputIsTTY: () => process.stdin.isTTY === true,
  outputIsTTY: () => process.stdout.isTTY === true,
  writeStdout: (text) => {
    process.stdout.write(text);
  },
  writeStderr: (text) => {
    process.stderr.write(text);
  },
};

function resolveIo(overrides: Partial<InstallerCliIo> | undefined) {
  return {
    inputIsTTY: overrides?.inputIsTTY ?? defaultIo.inputIsTTY,
    outputIsTTY: overrides?.outputIsTTY ?? defaultIo.outputIsTTY,
    writeStdout: overrides?.writeStdout ?? defaultIo.writeStdout,
    writeStderr: overrides?.writeStderr ?? defaultIo.writeStderr,
  } satisfies InstallerCliIo;
}

async function loadDefaultInteractiveSession(): Promise<InstallerExitCode> {
  const { runInteractiveSession } = await import("./interactive-session.js");
  return runInteractiveSession();
}

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

async function writeStderr(io: InstallerCliIo, text: string): Promise<void> {
  try {
    await io.writeStderr(text);
  } catch {
    // A broken diagnostic destination cannot change the selected exit code.
  }
}

async function writeInitializationFailure(
  io: InstallerCliIo,
  error: unknown,
): Promise<2> {
  const installerError =
    error instanceof InstallerError
      ? error
      : new InstallerError("INSTALLER_INITIALIZATION_FAILED", error);
  await writeStderr(io, renderInstallerDiagnostic(installerError));
  return 2;
}

export async function runInstallerCli(
  options: RunInstallerCliOptions = {},
): Promise<InstallerExitCode> {
  const io = resolveIo(options.io);
  const argv = options.argv ?? process.argv.slice(2);

  if (argv.length === 1 && argv[0] === "--help") {
    try {
      await io.writeStdout(helpText);
      return 0;
    } catch (error) {
      return writeInitializationFailure(io, error);
    }
  }
  if (argv.length === 1 && argv[0] === "--version") {
    try {
      const version = await (
        options.loadPackageVersion ?? loadDefaultPackageVersion
      )();
      await io.writeStdout(`${version}\n`);
      return 0;
    } catch (error) {
      return writeInitializationFailure(io, error);
    }
  }
  if (argv.length !== 0) {
    await writeStderr(io, invalidUsageText);
    return 2;
  }

  try {
    if (!io.inputIsTTY() || !io.outputIsTTY()) {
      await writeStderr(
        io,
        renderInstallerDiagnostic(new InstallerError("NO_TTY")),
      );
      return 2;
    }
    return await (
      options.loadInteractiveSession ?? loadDefaultInteractiveSession
    )();
  } catch (error) {
    return writeInitializationFailure(io, error);
  }
}
