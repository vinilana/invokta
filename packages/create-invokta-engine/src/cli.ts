import { CreatorError, renderCreatorDiagnostic } from "./errors.js";
import {
  createExampleProject,
  type ExampleFetch,
  resolveExampleReference,
} from "./example.js";
import { installProjectDependencies, selectPackageManager } from "./install.js";
import {
  isPackageManager,
  type PackageManager,
  packageManagerCommands,
} from "./package-manager.js";
import { createBoundedPromptInput, promptInputLimits } from "./prompt.js";
import {
  assertCreatableStarterTarget,
  planStarterProject,
  validateStarterTargetSyntax,
  writeStarterProject,
} from "./scaffold.js";
import {
  type EngineStarterProfile,
  isEngineStarterProfile,
} from "./starter.js";

const helpText = `Usage:
  create-invokta-engine [project-directory]
    [--profile complete|mcp-stdio|mcp-http|cli]
    [--example <name|github-url>]
    [--example-path <subdir>]
    [--package-manager npm|pnpm|yarn]
    [--no-install]
    [--yes]
  create-invokta-engine --help
  create-invokta-engine --version
`;

const invalidUsageText =
  'Invalid arguments. Run "create-invokta-engine --help".\n';
const unexpectedFailureText = "The project could not be created.\n";
const cancellationText = "Creation cancelled. No files were created.\n";
const profilePrompt =
  "Scaffold profile:\n" +
  "  1. Complete (CLI + MCP local + MCP HTTP)\n" +
  "  2. MCP local (stdio)\n" +
  "  3. MCP HTTP\n" +
  "  4. CLI\n" +
  "Choose a profile (1): ";
const promptDecoder = new TextDecoder("utf-8", { fatal: true });
const unsafeTerminalCharacterPattern = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

const profileAnswers = Object.freeze({
  "1": "complete",
  "2": "mcp-stdio",
  "3": "mcp-http",
  "4": "cli",
} as const satisfies Readonly<Record<string, EngineStarterProfile>>);

const profileLabels = Object.freeze({
  complete: "complete",
  "mcp-stdio": "MCP local",
  "mcp-http": "MCP HTTP",
  cli: "CLI",
} as const satisfies Readonly<Record<EngineStarterProfile, string>>);

export interface CreateEngineIo {
  readonly writeStdout: (text: string) => void | Promise<void>;
  readonly writeStderr: (text: string) => void | Promise<void>;
}

export interface CreateEngineTerminal {
  readonly stdinIsTty: boolean;
  readonly stderrIsTty: boolean;
  /** Returns one answer including its LF line terminator. */
  readonly readLine: () => Promise<Uint8Array | undefined>;
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

function createProcessTerminal(): CreateEngineTerminal {
  const input = createBoundedPromptInput(process.stdin);
  return Object.freeze({
    stdinIsTty: process.stdin.isTTY === true,
    stderrIsTty: process.stderr.isTTY === true,
    readLine: input.readLine,
  });
}

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
  readonly terminal?: CreateEngineTerminal;
  readonly install?: InstallProject;
  readonly loadPackageVersion?: () => Promise<string>;
  readonly fetch?: ExampleFetch;
}

interface CreateArguments {
  readonly target?: string;
  readonly profile?: EngineStarterProfile;
  readonly example?: string;
  readonly examplePath?: string;
  readonly packageManager?: PackageManager;
  readonly noInstall: boolean;
  readonly yes: boolean;
}

function parseCreateArguments(
  args: readonly string[],
): CreateArguments | undefined {
  let target: string | undefined;
  let profile: EngineStarterProfile | undefined;
  let profileSeen = false;
  let example: string | undefined;
  let exampleSeen = false;
  let examplePath: string | undefined;
  let examplePathSeen = false;
  let packageManager: PackageManager | undefined;
  let packageManagerSeen = false;
  let noInstall = false;
  let yes = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--no-install") {
      if (noInstall) return undefined;
      noInstall = true;
      continue;
    }
    if (argument === "--yes") {
      if (yes) return undefined;
      yes = true;
      continue;
    }
    if (argument === "--profile") {
      if (profileSeen) return undefined;
      profileSeen = true;
      const value = args[index + 1];
      if (value === undefined || !isEngineStarterProfile(value)) {
        return undefined;
      }
      profile = value;
      index += 1;
      continue;
    }
    if (argument === "--example") {
      if (exampleSeen) return undefined;
      exampleSeen = true;
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-") || value === "") {
        return undefined;
      }
      example = value;
      index += 1;
      continue;
    }
    if (argument === "--example-path") {
      if (examplePathSeen) return undefined;
      examplePathSeen = true;
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-") || value === "") {
        return undefined;
      }
      examplePath = value;
      index += 1;
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

  if (yes && target === undefined) return undefined;
  if (examplePath !== undefined && example === undefined) return undefined;
  if (example !== undefined && profile !== undefined) return undefined;
  return {
    ...(target === undefined ? {} : { target }),
    ...(profile === undefined ? {} : { profile }),
    ...(example === undefined ? {} : { example }),
    ...(examplePath === undefined ? {} : { examplePath }),
    ...(packageManager === undefined ? {} : { packageManager }),
    noInstall,
    yes,
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
  sourceLabel: string,
  packageManager: PackageManager,
  noInstall: boolean,
): string {
  const commands = packageManagerCommands[packageManager];
  const firstLine = `Created ${projectName} ${sourceLabel}.`;
  if (noInstall) {
    return (
      `${firstLine}\n\n` +
      "Next steps:\n" +
      `  ${commands.installDisplay}\n` +
      `  ${commands.check}\n`
    );
  }
  return `${firstLine}\n\nNext step:\n  ${commands.check}\n`;
}

function decodePromptAnswer(answer: Uint8Array | undefined): string {
  if (
    answer !== undefined &&
    answer.byteLength > promptInputLimits.maxAnswerBytes
  ) {
    throw new CreatorError("PROMPT_INVALID");
  }
  if (answer === undefined || answer.at(-1) !== 0x0a) {
    throw new CreatorError("PROMPT_ABORTED");
  }
  let end = answer.byteLength - 1;
  if (end > 0 && answer[end - 1] === 0x0d) end -= 1;
  try {
    return promptDecoder.decode(answer.subarray(0, end)).trim();
  } catch {
    throw new CreatorError("PROMPT_INVALID");
  }
}

async function readPromptAnswer(
  io: CreateEngineIo,
  terminal: CreateEngineTerminal,
  prompt: string,
): Promise<string> {
  let answer: Uint8Array | undefined;
  try {
    await io.writeStderr(prompt);
    answer = await terminal.readLine();
  } catch {
    throw new CreatorError("PROMPT_ABORTED");
  }
  return decodePromptAnswer(answer);
}

async function promptForTarget(
  cwd: string,
  io: CreateEngineIo,
  terminal: CreateEngineTerminal,
): Promise<string> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const answer = await readPromptAnswer(
      io,
      terminal,
      "Project directory (my-invokta-engine): ",
    );
    const target = answer === "" ? "my-invokta-engine" : answer;
    try {
      validateStarterTargetSyntax(cwd, target);
      return target;
    } catch (error) {
      if (!(error instanceof CreatorError) || error.code !== "TARGET_INVALID") {
        throw error;
      }
      if (attempt === 3) throw new CreatorError("PROMPT_INVALID");
    }
  }
  throw new CreatorError("PROMPT_INVALID");
}

async function promptForProfile(
  io: CreateEngineIo,
  terminal: CreateEngineTerminal,
): Promise<EngineStarterProfile> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const answer = await readPromptAnswer(io, terminal, profilePrompt);
    if (answer === "") return "complete";
    const profile = profileAnswers[answer as keyof typeof profileAnswers];
    if (profile !== undefined) return profile;
    if (attempt === 3) throw new CreatorError("PROMPT_INVALID");
  }
  throw new CreatorError("PROMPT_INVALID");
}

function escapeTerminalCharacter(character: string): string {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) return "";
  if (codePoint <= 0xffff) {
    return `\\u${codePoint.toString(16).padStart(4, "0")}`;
  }
  return `\\u{${codePoint.toString(16)}}`;
}

function quoteTerminalValue(value: string): string {
  return JSON.stringify(value).replace(
    unsafeTerminalCharacterPattern,
    escapeTerminalCharacter,
  );
}

function renderProfileConfirmation(
  profile: EngineStarterProfile,
  normalizedTarget: string,
  packageManager: PackageManager,
  noInstall: boolean,
): string {
  const installation = noInstall
    ? "without installing dependencies"
    : `and install dependencies with ${packageManager}`;
  return `Create the ${profileLabels[profile]} scaffold in ${quoteTerminalValue(normalizedTarget)} ${installation}? (y/N) `;
}

function renderExampleConfirmation(
  exampleLabel: string,
  normalizedTarget: string,
  packageManager: PackageManager,
  noInstall: boolean,
): string {
  const installation = noInstall
    ? "without installing dependencies"
    : `and install dependencies with ${packageManager}`;
  return `Create from GitHub example ${quoteTerminalValue(exampleLabel)} in ${quoteTerminalValue(normalizedTarget)} ${installation}? (y/N) `;
}

async function promptForConfirmation(
  io: CreateEngineIo,
  terminal: CreateEngineTerminal,
  prompt: string,
): Promise<boolean> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const answer = (await readPromptAnswer(io, terminal, prompt)).toLowerCase();
    if (answer === "" || answer === "n" || answer === "no") return false;
    if (answer === "y" || answer === "yes") return true;
    if (attempt === 3) throw new CreatorError("PROMPT_INVALID");
  }
  throw new CreatorError("PROMPT_INVALID");
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

  const terminal = options.terminal ?? createProcessTerminal();
  const interactive =
    !parsed.yes && terminal.stdinIsTty && terminal.stderrIsTty;
  if (!interactive && parsed.target === undefined) {
    const error = new CreatorError("INTERACTIVE_REQUIRED");
    await writeDiagnostic(io, renderCreatorDiagnostic(error));
    return error.exitCode;
  }

  const cwd = options.cwd ?? process.cwd();
  try {
    const target = parsed.target ?? (await promptForTarget(cwd, io, terminal));
    const environment = options.env ?? process.env;
    const packageManager = selectPackageManager(
      parsed.packageManager,
      environment.npm_config_user_agent,
    );

    if (parsed.example !== undefined) {
      const exampleInfo = await resolveExampleReference(
        parsed.example,
        parsed.examplePath,
        options.fetch,
      );
      const targetMeta = await assertCreatableStarterTarget(cwd, target);

      if (interactive) {
        const confirmed = await promptForConfirmation(
          io,
          terminal,
          renderExampleConfirmation(
            exampleInfo.label,
            targetMeta.normalizedTarget,
            packageManager,
            parsed.noInstall,
          ),
        );
        if (!confirmed) {
          await io.writeStdout(cancellationText);
          return 0;
        }
      }

      const project = await createExampleProject({
        cwd,
        target,
        example: parsed.example,
        ...(parsed.examplePath === undefined
          ? {}
          : { examplePath: parsed.examplePath }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
      if (!parsed.noInstall) {
        await (options.install ?? installProjectDependencies)({
          directory: project.directory,
          packageManager,
        });
      }
      await io.writeStdout(
        renderSuccess(
          project.projectName,
          `from example ${project.label}`,
          packageManager,
          parsed.noInstall,
        ),
      );
      return 0;
    }

    const profile =
      parsed.profile ??
      (interactive ? await promptForProfile(io, terminal) : "complete");
    const invoktaVersion = await (
      options.loadPackageVersion ?? loadDefaultPackageVersion
    )();
    const plan = await planStarterProject({
      cwd,
      target,
      invoktaVersion,
      packageManager,
      profile,
    });

    if (interactive) {
      const confirmed = await promptForConfirmation(
        io,
        terminal,
        renderProfileConfirmation(
          profile,
          plan.normalizedTarget,
          packageManager,
          parsed.noInstall,
        ),
      );
      if (!confirmed) {
        await io.writeStdout(cancellationText);
        return 0;
      }
    }

    const project = await writeStarterProject(plan);
    if (!parsed.noInstall) {
      await (options.install ?? installProjectDependencies)({
        directory: project.directory,
        packageManager,
      });
    }
    await io.writeStdout(
      renderSuccess(
        project.projectName,
        `with the ${profileLabels[profile]} scaffold`,
        packageManager,
        parsed.noInstall,
      ),
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
