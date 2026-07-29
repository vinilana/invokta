import { CreatorError, renderCreatorDiagnostic } from "./errors.js";
import { installProjectDependencies, selectPackageManager } from "./install.js";
import {
  isPackageManager,
  type PackageManager,
  packageManagerCommands,
} from "./package-manager.js";
import { createStarterProject } from "./scaffold.js";

const helpText = `Usage:
  create-invokta-engine <project-directory>
    [--package-manager npm|pnpm|yarn] [--no-install]
  create-invokta-engine --help
  create-invokta-engine --version
`;

const invalidUsageText =
  'Invalid arguments. Run "create-invokta-engine --help".\n';
const unexpectedFailureText = "The project could not be created.\n";

export interface CreateEngineIo {
  readonly writeStdout: (text: string) => void | Promise<void>;
  readonly writeStderr: (text: string) => void | Promise<void>;
}

const processIo: CreateEngineIo = {
  writeStdout(text) {
    process.stdout.write(text);
  },
  writeStderr(text) {
    process.stderr.write(text);
  },
};

const defaultIo: CreateEngineIo = Object.freeze(processIo);

export interface InstallProjectOptions {
  readonly directory: string;
  readonly packageManager: PackageManager;
}

export type InstallProject = (options: InstallProjectOptions) => Promise<void>;

export interface RunCreateEngineCliOptions {
  readonly argv?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly io?: CreateEngineIo;
  readonly install?: InstallProject;
  readonly loadPackageVersion?: () => Promise<string>;
}

interface CreateArguments {
  readonly target: string;
  readonly packageManager?: PackageManager;
  readonly noInstall: boolean;
}

function parseCreateArguments(
  args: readonly string[],
): CreateArguments | undefined {
  let target: string | undefined;
  let packageManager: PackageManager | undefined;
  let packageManagerSeen = false;
  let noInstall = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--no-install") {
      if (noInstall) return undefined;
      noInstall = true;
      continue;
    }
    if (argument === "--package-manager") {
      if (packageManagerSeen) return undefined;
      packageManagerSeen = true;
      const value = args[index + 1];
      if (value === undefined || !isPackageManager(value)) return undefined;
      packageManager = value;
      index += 1;
      continue;
    }
    if (
      argument === undefined ||
      argument.startsWith("-") ||
      target !== undefined
    ) {
      return undefined;
    }
    target = argument;
  }

  if (target === undefined) return undefined;
  return {
    target,
    ...(packageManager === undefined ? {} : { packageManager }),
    noInstall,
  };
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
    throw new Error("The package version is unreadable.");
  }
  return version;
}

async function writeDiagnostic(
  io: CreateEngineIo,
  text: string,
): Promise<void> {
  try {
    await io.writeStderr(text);
  } catch {
    // A broken diagnostic stream does not replace the command's numeric result.
  }
}

function renderSuccess(
  projectName: string,
  packageManager: PackageManager,
  noInstall: boolean,
): string {
  const commands = packageManagerCommands[packageManager];
  if (noInstall) {
    return (
      `Created ${projectName} without installing dependencies.\n\n` +
      "Next steps:\n" +
      `  ${commands.installDisplay}\n` +
      `  ${commands.check}\n`
    );
  }
  return `Created ${projectName}.\n\nNext step:\n  ${commands.check}\n`;
}

/** Runs the binary command and returns its exit status without exiting. */
export async function runCreateEngineCli(
  options: RunCreateEngineCliOptions = {},
): Promise<0 | 1 | 2> {
  const argv = options.argv ?? process.argv.slice(2);
  const io = options.io ?? defaultIo;
  const [first, ...rest] = argv;

  if (first === "--help" || first === "--version") {
    if (rest.length > 0) {
      await writeDiagnostic(io, invalidUsageText);
      return 2;
    }
    try {
      const output =
        first === "--help"
          ? helpText
          : `${await (options.loadPackageVersion ?? loadDefaultPackageVersion)()}\n`;
      await io.writeStdout(output);
      return 0;
    } catch {
      await writeDiagnostic(io, unexpectedFailureText);
      return 1;
    }
  }

  const parsed = parseCreateArguments(argv);
  if (parsed === undefined) {
    await writeDiagnostic(io, invalidUsageText);
    return 2;
  }

  const environment = options.env ?? process.env;
  const packageManager = selectPackageManager(
    parsed.packageManager,
    environment.npm_config_user_agent,
  );
  try {
    const invoktaVersion = await (
      options.loadPackageVersion ?? loadDefaultPackageVersion
    )();
    const project = await createStarterProject({
      cwd: options.cwd ?? process.cwd(),
      target: parsed.target,
      invoktaVersion,
      packageManager,
    });
    if (!parsed.noInstall) {
      await (options.install ?? installProjectDependencies)({
        directory: project.directory,
        packageManager,
      });
    }
    await io.writeStdout(
      renderSuccess(project.projectName, packageManager, parsed.noInstall),
    );
    return 0;
  } catch (error) {
    if (error instanceof CreatorError) {
      await writeDiagnostic(io, renderCreatorDiagnostic(error));
      return error.exitCode;
    }
    await writeDiagnostic(io, unexpectedFailureText);
    return 1;
  }
}
