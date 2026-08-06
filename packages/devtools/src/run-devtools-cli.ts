import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { startAttachedDevtoolsServer } from "./attached-server.js";
import {
  describeThrownValue,
  programName,
  quote,
  renderLines,
  token,
  UsageError,
} from "./diagnostics.js";
import type { DoctorFinding, DoctorNote, DoctorReport } from "./doctor.js";
import { inspectEngine } from "./doctor.js";
import {
  hasComposedCapabilitiesExport,
  loadEngineModule,
} from "./load-engine.js";
import type { StartServeOptions, StartServeResult } from "./serve.js";
import { startServe } from "./serve.js";
import { runMcpVerification } from "./verify-mcp.js";

export interface DevtoolsIo {
  readonly writeStdout: (text: string) => void | Promise<void>;
  readonly writeStderr: (text: string) => void | Promise<void>;
}

export interface RunDevtoolsCliOptions {
  /** Defaults to `process.argv.slice(2)`. */
  readonly argv?: readonly string[];
  /** Directory the module path is resolved against. Defaults to `process.cwd()`. */
  readonly cwd?: string;
  readonly io?: Partial<DevtoolsIo>;
}

export interface DoctorCommand {
  readonly command: "doctor";
  readonly moduleSpecifier: string;
  readonly exportName: string;
}

export interface ServeCommand {
  readonly command: "serve";
  readonly moduleSpecifier: string;
  readonly exportName: string;
  readonly port?: number;
  readonly enginePort?: number;
  readonly buildCommand?: string;
}

export interface OpenCommand {
  readonly command: "open";
  readonly port?: number;
}

export interface VerifyEnvironmentReference {
  readonly childName: string;
  readonly sourceName: string;
}

export interface VerifyHeaderEnvironmentReference {
  readonly headerName: string;
  readonly sourceName: string;
}

export interface VerifyStdioCommand {
  readonly command: "verify";
  readonly target: {
    readonly transport: "stdio";
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd?: string;
    readonly environment: readonly VerifyEnvironmentReference[];
  };
}

export interface VerifyHttpCommand {
  readonly command: "verify";
  readonly target: {
    readonly transport: "http";
    readonly url: string;
    readonly authentication:
      | { readonly type: "none" }
      | { readonly type: "bearer"; readonly sourceName: string }
      | {
          readonly type: "headers";
          readonly headers: readonly VerifyHeaderEnvironmentReference[];
        };
  };
}

export type VerifyCommand = VerifyStdioCommand | VerifyHttpCommand;
export type ParsedDevtoolsCommand =
  | DoctorCommand
  | ServeCommand
  | OpenCommand
  | VerifyCommand;
type EngineCommand = DoctorCommand | ServeCommand;

export type ResolvedVerifyTarget =
  | {
      readonly transport: "stdio";
      readonly command: string;
      readonly args: readonly string[];
      readonly cwd?: string;
      readonly env?: Readonly<Record<string, string>>;
    }
  | {
      readonly transport: "http";
      readonly url: string;
      readonly authentication:
        | { readonly type: "none" }
        | { readonly type: "bearer"; readonly token: string }
        | {
            readonly type: "headers";
            readonly headers: Readonly<Record<string, string>>;
          };
    };

export class VerifyEnvironmentError extends Error {
  readonly code: "ENVIRONMENT_VALUE_MISSING" | "INVALID_TARGET";

  constructor(
    code: "ENVIRONMENT_VALUE_MISSING" | "INVALID_TARGET",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "VerifyEnvironmentError";
    this.code = code;
  }
}

const defaultExportName = "engine";
const mcpManifestFileName = "invokta.mcp.json";

const engineUsage = `Usage:
  invokta-devtools doctor <esm-module> [--export <name>]
  invokta-devtools serve <esm-module> [--export <name>] [--port <number>]
    [--engine-port <number>] [--watch --build <command>]

The module path is resolved against the current working directory and must
already be built to ESM. The selected export defaults to "engine" and must be
the value returned by createEngine.

serve preflights the engine with the doctor checks, hosts it with the MCP
HTTP adapter on loopback, and serves the development interface on
http://127.0.0.1:4100/ unless --port selects another loopback port.

--watch requires --build and runs the engine in a replaceable child process:
project changes run the explicit build command, and only a successful build
replaces the running engine host. Modules are never reloaded in process.

Exit codes:
  0  the engine passed the doctor checks, or the dev server shut down cleanly
  1  the doctor reported findings, or the dev server could not start
  2  invalid usage, a module that failed to load, a missing export, or an
     export that is not an engine`;

const usage = engineUsage.replace(
  "Usage:\n",
  `Usage:
  invokta-devtools [--port <number>]
  invokta-devtools open [--port <number>]
  invokta-devtools verify --stdio <executable> [--arg <value>]...
    [--cwd <directory>] [--env <child-name>=<source-environment-name>]...
  invokta-devtools verify --http <url> [--auth <none|bearer|headers>]
    [--bearer-env <environment-name>]
    [--header-env <header-name>=<environment-name>]...
`,
);

function parseModuleArguments(args: readonly string[]): {
  readonly moduleSpecifier: string;
  readonly exportName: string;
} {
  let moduleSpecifier: string | undefined;
  let exportName: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument === "--export") {
      if (exportName !== undefined) {
        throw new UsageError(
          "The --export option must be provided at most once.",
        );
      }
      const value = args[index + 1];
      if (value === undefined || value === "" || value.startsWith("-")) {
        throw new UsageError("The --export option requires a name.");
      }
      exportName = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new UsageError(`Unknown option ${quote(argument)}.`);
    }
    if (argument === "") {
      throw new UsageError("The module path must not be empty.");
    }
    if (moduleSpecifier !== undefined) {
      throw new UsageError("Exactly one module path is required.");
    }
    moduleSpecifier = argument;
  }

  if (moduleSpecifier === undefined) {
    throw new UsageError("A module path is required.");
  }
  return { moduleSpecifier, exportName: exportName ?? defaultExportName };
}

function parsePort(option: string, value: string | undefined): number {
  if (value === undefined || value === "" || value.startsWith("-")) {
    throw new UsageError(`The ${option} option requires a port number.`);
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new UsageError(
      `The ${option} option requires a port between 1 and 65535.`,
    );
  }
  return port;
}

function parseOpenArguments(
  args: readonly string[],
): Omit<OpenCommand, "command"> {
  let port: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument === "--port") {
      if (port !== undefined) {
        throw new UsageError(
          "The --port option must be provided at most once.",
        );
      }
      port = parsePort("--port", args[index + 1]);
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new UsageError(`Unknown option ${quote(argument)}.`);
    }
    throw new UsageError(
      "The open command does not accept positional arguments.",
    );
  }
  return port === undefined ? {} : { port };
}

const environmentNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const headerNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const transportOwnedHeaderNames = new Set([
  "accept",
  "connection",
  "content-length",
  "content-type",
  "cookie",
  "host",
  "last-event-id",
  "mcp-protocol-version",
  "mcp-session-id",
  "origin",
  "set-cookie",
  "transfer-encoding",
  "upgrade",
]);

function requiredOptionValue(
  option: string,
  value: string | undefined,
): string {
  if (value === undefined || value === "" || value.startsWith("-")) {
    throw new UsageError(`The ${option} option requires a value.`);
  }
  return value;
}

function parseEnvironmentPair(
  option: "--env" | "--header-env",
  value: string | undefined,
): readonly [string, string] {
  if (value === undefined || value === "") {
    const shape = option === "--env" ? "CHILD=SOURCE" : "HEADER=SOURCE";
    throw new UsageError(`The ${option} option requires ${shape}.`);
  }
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) {
    const shape = option === "--env" ? "CHILD=SOURCE" : "HEADER=SOURCE";
    throw new UsageError(`The ${option} option requires ${shape}.`);
  }
  return [value.slice(0, separator), value.slice(separator + 1)];
}

function assertEnvironmentName(name: string, option: string): void {
  if (!environmentNamePattern.test(name)) {
    throw new UsageError(
      `The ${option} option requires valid environment variable names.`,
    );
  }
}

function assertHttpUrl(value: string): void {
  if (
    value !== value.trim() ||
    (!value.startsWith("https://") && !value.startsWith("http://"))
  ) {
    throw new UsageError("The --http option requires an absolute HTTP URL.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError("The --http option requires an absolute HTTP URL.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new UsageError("The --http URL must not contain credentials.");
  }
  if (value.includes("?")) {
    throw new UsageError("The --http URL must not contain a query.");
  }
  if (value.includes("#")) {
    throw new UsageError("The --http URL must not contain a fragment.");
  }
  if (url.hostname === "") {
    throw new UsageError("The --http option requires an absolute HTTP URL.");
  }
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "[::1]")
    )
  ) {
    throw new UsageError(
      "The --http URL requires HTTPS except for a literal loopback address.",
    );
  }
  if (url.href !== value && url.href !== `${value}/`) {
    throw new UsageError(
      "The --http option requires a canonical absolute HTTP URL.",
    );
  }
}

function assertHeaderName(name: string): void {
  if (!headerNamePattern.test(name)) {
    throw new UsageError(
      "The --header-env option requires a valid HTTP field name.",
    );
  }
  const normalized = name.toLowerCase();
  if (
    transportOwnedHeaderNames.has(normalized) ||
    normalized.startsWith("proxy-") ||
    normalized.startsWith("sec-")
  ) {
    throw new UsageError(
      "The --header-env option cannot set a transport-owned header.",
    );
  }
}

function parseVerifyArguments(args: readonly string[]): VerifyCommand {
  let stdioCommand: string | undefined;
  let httpUrl: string | undefined;
  let stdioProvided = false;
  let httpProvided = false;
  const stdioArgs: string[] = [];
  let cwd: string | undefined;
  const environment: VerifyEnvironmentReference[] = [];
  const environmentChildNames = new Set<string>();
  let auth: "none" | "bearer" | "headers" | undefined;
  let bearerSourceName: string | undefined;
  const headerEnvironment: VerifyHeaderEnvironmentReference[] = [];
  const normalizedHeaderNames = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument === "--stdio") {
      if (stdioProvided) {
        throw new UsageError(
          "The --stdio option must be provided at most once.",
        );
      }
      stdioProvided = true;
      stdioCommand = requiredOptionValue("--stdio", args[index + 1]);
      index += 1;
      continue;
    }
    if (argument === "--http") {
      if (httpProvided) {
        throw new UsageError(
          "The --http option must be provided at most once.",
        );
      }
      httpProvided = true;
      httpUrl = requiredOptionValue("--http", args[index + 1]);
      index += 1;
      continue;
    }
    if (argument === "--arg") {
      const value = args[index + 1];
      if (value === undefined) {
        throw new UsageError("The --arg option requires a value.");
      }
      stdioArgs.push(value);
      index += 1;
      continue;
    }
    if (argument === "--cwd") {
      if (cwd !== undefined) {
        throw new UsageError("The --cwd option must be provided at most once.");
      }
      cwd = requiredOptionValue("--cwd", args[index + 1]);
      index += 1;
      continue;
    }
    if (argument === "--env") {
      const [childName, sourceName] = parseEnvironmentPair(
        "--env",
        args[index + 1],
      );
      assertEnvironmentName(childName, "--env");
      assertEnvironmentName(sourceName, "--env");
      if (environmentChildNames.has(childName)) {
        throw new UsageError(
          "The --env option must provide each child name at most once.",
        );
      }
      environmentChildNames.add(childName);
      environment.push({ childName, sourceName });
      index += 1;
      continue;
    }
    if (argument === "--auth") {
      if (auth !== undefined) {
        throw new UsageError(
          "The --auth option must be provided at most once.",
        );
      }
      const value = requiredOptionValue("--auth", args[index + 1]);
      if (value !== "none" && value !== "bearer" && value !== "headers") {
        throw new UsageError(
          "The --auth option must be none, bearer, or headers.",
        );
      }
      auth = value;
      index += 1;
      continue;
    }
    if (argument === "--bearer-env") {
      if (bearerSourceName !== undefined) {
        throw new UsageError(
          "The --bearer-env option must be provided at most once.",
        );
      }
      bearerSourceName = requiredOptionValue("--bearer-env", args[index + 1]);
      assertEnvironmentName(bearerSourceName, "--bearer-env");
      index += 1;
      continue;
    }
    if (argument === "--header-env") {
      const [headerName, sourceName] = parseEnvironmentPair(
        "--header-env",
        args[index + 1],
      );
      assertHeaderName(headerName);
      assertEnvironmentName(sourceName, "--header-env");
      const normalizedName = headerName.toLowerCase();
      if (normalizedHeaderNames.has(normalizedName)) {
        throw new UsageError(
          "The --header-env names must be case-insensitively unique.",
        );
      }
      normalizedHeaderNames.add(normalizedName);
      headerEnvironment.push({ headerName, sourceName });
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new UsageError(`Unknown option ${quote(argument)}.`);
    }
    throw new UsageError(
      "The verify command does not accept positional arguments.",
    );
  }

  if (stdioProvided === httpProvided) {
    throw new UsageError(
      "The verify command requires exactly one of --stdio and --http.",
    );
  }

  if (stdioProvided) {
    if (
      auth !== undefined ||
      bearerSourceName !== undefined ||
      headerEnvironment.length > 0
    ) {
      throw new UsageError(
        "The --auth, --bearer-env, and --header-env options are valid only with --http.",
      );
    }
    return {
      command: "verify",
      target: {
        transport: "stdio",
        command: stdioCommand as string,
        args: stdioArgs,
        ...(cwd === undefined ? {} : { cwd }),
        environment,
      },
    };
  }

  if (stdioArgs.length > 0 || cwd !== undefined || environment.length > 0) {
    throw new UsageError(
      "The --arg, --cwd, and --env options are valid only with --stdio.",
    );
  }
  assertHttpUrl(httpUrl as string);
  const authentication = auth ?? "none";
  if (authentication === "none") {
    if (bearerSourceName !== undefined) {
      throw new UsageError("Authentication none forbids --bearer-env.");
    }
    if (headerEnvironment.length > 0) {
      throw new UsageError("Authentication none forbids --header-env.");
    }
    return {
      command: "verify",
      target: {
        transport: "http",
        url: httpUrl as string,
        authentication: { type: "none" },
      },
    };
  }
  if (authentication === "bearer") {
    if (bearerSourceName === undefined) {
      throw new UsageError("Authentication bearer requires --bearer-env.");
    }
    if (headerEnvironment.length > 0) {
      throw new UsageError("Authentication bearer forbids --header-env.");
    }
    return {
      command: "verify",
      target: {
        transport: "http",
        url: httpUrl as string,
        authentication: { type: "bearer", sourceName: bearerSourceName },
      },
    };
  }
  if (bearerSourceName !== undefined) {
    throw new UsageError("Authentication headers forbids --bearer-env.");
  }
  if (headerEnvironment.length === 0) {
    throw new UsageError(
      "Authentication headers requires at least one --header-env.",
    );
  }
  return {
    command: "verify",
    target: {
      transport: "http",
      url: httpUrl as string,
      authentication: { type: "headers", headers: headerEnvironment },
    },
  };
}

function parseServeArguments(
  args: readonly string[],
): Omit<ServeCommand, "command"> {
  const positional: string[] = [];
  let exportName: string | undefined;
  let port: number | undefined;
  let enginePort: number | undefined;
  let watch = false;
  let buildCommand: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument === "--watch") {
      if (watch) {
        throw new UsageError(
          "The --watch option must be provided at most once.",
        );
      }
      watch = true;
      continue;
    }
    if (argument === "--build") {
      if (buildCommand !== undefined) {
        throw new UsageError(
          "The --build option must be provided at most once.",
        );
      }
      const value = args[index + 1];
      if (value === undefined || value === "" || value.startsWith("-")) {
        throw new UsageError("The --build option requires a command.");
      }
      buildCommand = value;
      index += 1;
      continue;
    }
    if (argument === "--export") {
      if (exportName !== undefined) {
        throw new UsageError(
          "The --export option must be provided at most once.",
        );
      }
      const value = args[index + 1];
      if (value === undefined || value === "" || value.startsWith("-")) {
        throw new UsageError("The --export option requires a name.");
      }
      exportName = value;
      index += 1;
      continue;
    }
    if (argument === "--port") {
      if (port !== undefined) {
        throw new UsageError(
          "The --port option must be provided at most once.",
        );
      }
      port = parsePort("--port", args[index + 1]);
      index += 1;
      continue;
    }
    if (argument === "--engine-port") {
      if (enginePort !== undefined) {
        throw new UsageError(
          "The --engine-port option must be provided at most once.",
        );
      }
      enginePort = parsePort("--engine-port", args[index + 1]);
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new UsageError(`Unknown option ${quote(argument)}.`);
    }
    if (argument === "") {
      throw new UsageError("The module path must not be empty.");
    }
    positional.push(argument);
  }

  if (positional.length === 0) {
    throw new UsageError("A module path is required.");
  }
  if (positional.length > 1) {
    throw new UsageError("Exactly one module path is required.");
  }
  if (watch !== (buildCommand !== undefined)) {
    throw new UsageError(
      "The --watch and --build options must be provided together.",
    );
  }
  return {
    moduleSpecifier: positional[0] as string,
    exportName: exportName ?? defaultExportName,
    ...(port === undefined ? {} : { port }),
    ...(enginePort === undefined ? {} : { enginePort }),
    ...(buildCommand === undefined ? {} : { buildCommand }),
  };
}

/**
 * Parses the complete command line without reading the process environment or
 * performing module, filesystem, process, or network work.
 */
export function parseDevtoolsCommand(
  argv: readonly string[],
): ParsedDevtoolsCommand {
  const [command, ...args] = argv;
  if (command === undefined) return { command: "open" };
  if (command.startsWith("-")) {
    return { command: "open", ...parseOpenArguments(argv) };
  }
  if (command === "open") {
    return { command: "open", ...parseOpenArguments(args) };
  }
  if (command === "verify") {
    return parseVerifyArguments(args);
  }
  if (command === "doctor") {
    return { command: "doctor", ...parseModuleArguments(args) };
  }
  if (command === "serve") {
    return { command: "serve", ...parseServeArguments(args) };
  }
  throw new UsageError(`Unknown command ${quote(command)}.`);
}

/**
 * Resolves already-validated environment references into a plain MCP target.
 * Callers must parse the entire argv first; this function never receives argv
 * and cannot make an invalid option combination trigger a credential lookup.
 */
export function resolveVerifyTargetEnvironment(
  command: ParsedDevtoolsCommand,
  readEnvironmentValue: (name: string) => string | undefined,
): ResolvedVerifyTarget {
  if (command.command !== "verify") {
    throw new TypeError("A parsed verify command is required.");
  }
  if (command.target.transport === "stdio") {
    const entries = command.target.environment.map(
      ({ childName, sourceName }) => {
        const value = readEnvironmentValue(sourceName);
        if (value === undefined || value === "") {
          throw new VerifyEnvironmentError(
            "ENVIRONMENT_VALUE_MISSING",
            "A required environment value is missing.",
          );
        }
        return [childName, value] as const;
      },
    );
    return {
      transport: "stdio",
      command: command.target.command,
      args: [...command.target.args],
      ...(command.target.cwd === undefined ? {} : { cwd: command.target.cwd }),
      ...(entries.length === 0 ? {} : { env: Object.fromEntries(entries) }),
    };
  }
  if (command.target.authentication.type === "none") {
    return {
      transport: "http",
      url: command.target.url,
      authentication: { type: "none" },
    };
  }
  if (command.target.authentication.type === "bearer") {
    const tokenValue = readEnvironmentValue(
      command.target.authentication.sourceName,
    );
    if (tokenValue === undefined || tokenValue === "") {
      throw new VerifyEnvironmentError(
        "ENVIRONMENT_VALUE_MISSING",
        "A required environment value is missing.",
      );
    }
    if (
      tokenValue.startsWith(" ") ||
      tokenValue.startsWith("\t") ||
      tokenValue.endsWith(" ") ||
      tokenValue.endsWith("\t") ||
      tokenValue.includes("\r") ||
      tokenValue.includes("\n")
    ) {
      throw new VerifyEnvironmentError(
        "INVALID_TARGET",
        "The bearer environment value is not a valid header value.",
      );
    }
    return {
      transport: "http",
      url: command.target.url,
      authentication: { type: "bearer", token: tokenValue },
    };
  }
  const headerEntries = command.target.authentication.headers.map(
    ({ headerName, sourceName }) => {
      const value = readEnvironmentValue(sourceName);
      if (value === undefined) {
        throw new VerifyEnvironmentError(
          "ENVIRONMENT_VALUE_MISSING",
          "A required environment value is missing.",
        );
      }
      if (value.includes("\r") || value.includes("\n")) {
        throw new VerifyEnvironmentError(
          "INVALID_TARGET",
          "A custom header environment value is not valid.",
        );
      }
      return [headerName, value] as const;
    },
  );
  return {
    transport: "http",
    url: command.target.url,
    authentication: {
      type: "headers",
      headers: Object.fromEntries(headerEntries),
    },
  };
}

function renderContext(command: EngineCommand): readonly string[] {
  return [
    `module: ${quote(command.moduleSpecifier)}`,
    `export: ${quote(command.exportName)}`,
  ];
}

function renderUsageError(error: UsageError, selectedUsage = usage): string {
  return renderLines([`${programName}: ${error.message}`, "", selectedUsage]);
}

function renderVerifyFailure(
  code: "ENVIRONMENT_VALUE_MISSING" | "INVALID_TARGET",
): string {
  const message =
    code === "ENVIRONMENT_VALUE_MISSING"
      ? "A required environment value is missing."
      : "The verify command arguments are invalid.";
  return `${programName} verify: ${code}: ${message}\n`;
}

function renderLoadFailure(command: EngineCommand, error: unknown): string {
  return renderLines([
    `${programName}: the module could not be loaded.`,
    ...renderContext(command),
    describeThrownValue(error),
  ]);
}

function renderMissingExport(command: EngineCommand): string {
  return renderLines([
    `${programName}: the module does not provide the requested export.`,
    ...renderContext(command),
    "reason: build the engine module and export the value returned by createEngine.",
  ]);
}

function renderNotAnEngine(command: EngineCommand): string {
  return renderLines([
    `${programName}: the selected export is not an engine.`,
    ...renderContext(command),
    "reason: an engine provides name, version, invoke, list, and describe.",
  ]);
}

function renderFinding(finding: DoctorFinding): string {
  if (finding.code === "LIST_UNREADABLE") {
    const suffix =
      finding.error === undefined
        ? ""
        : ` ${describeThrownValue(finding.error)}`;
    return `finding: code="LIST_UNREADABLE"${suffix}`;
  }
  if (finding.code === "DESCRIBE_FAILED") {
    const suffix =
      finding.error === undefined
        ? ""
        : ` ${describeThrownValue(finding.error)}`;
    return `finding: code="DESCRIBE_FAILED" capabilityId=${quote(finding.capabilityId)}${suffix}`;
  }
  return `finding: code="SCHEMA_UNREADABLE" capabilityId=${quote(finding.capabilityId)} schema=${quote(finding.schema)}`;
}

function renderNote(note: DoctorNote): string {
  if (note.code === "TITLE_MISSING" || note.code === "ANNOTATIONS_MISSING") {
    return `note: code=${quote(note.code)} capabilityId=${quote(note.capabilityId)}`;
  }
  if (note.code === "COMPOSITION_CHECK_AVAILABLE") {
    return `note: code="COMPOSITION_CHECK_AVAILABLE" reason: run "invokta check-capabilities" against the composed export.`;
  }
  return `note: code=${quote(note.code)}`;
}

function renderReport(command: EngineCommand, report: DoctorReport): string {
  const passed = report.findings.length === 0;
  const capabilityCount =
    report.capabilityCount === undefined
      ? '"<unreadable>"'
      : String(report.capabilityCount);
  const lines = [
    passed
      ? `${programName}: the engine passed the doctor checks.`
      : `${programName}: the engine failed the doctor checks.`,
    ...renderContext(command),
    `engine: name=${token(report.engineName)} version=${token(report.engineVersion)} capabilities=${capabilityCount}`,
  ];
  if (report.findings.length > 0) {
    lines.push(`findings: ${String(report.findings.length)}`);
    lines.push(...report.findings.map(renderFinding));
  }
  lines.push(`notes: ${String(report.notes.length)}`);
  lines.push(...report.notes.map(renderNote));
  return renderLines(lines);
}

function resolveIo(overrides: Partial<DevtoolsIo> | undefined): DevtoolsIo {
  return {
    writeStdout:
      overrides?.writeStdout ??
      ((text: string) => {
        process.stdout.write(text);
      }),
    writeStderr:
      overrides?.writeStderr ??
      ((text: string) => {
        process.stderr.write(text);
      }),
  };
}

async function writeStderr(io: DevtoolsIo, text: string): Promise<void> {
  try {
    await io.writeStderr(text);
  } catch {
    // A diagnostic destination cannot change the command's numeric result.
  }
}

async function runDoctor(
  command: DoctorCommand,
  cwd: string,
  io: DevtoolsIo,
): Promise<number> {
  const loaded = await loadEngineModule({
    moduleSpecifier: command.moduleSpecifier,
    exportName: command.exportName,
    cwd,
  });
  if (loaded.kind === "load-failed") {
    await writeStderr(io, renderLoadFailure(command, loaded.error));
    return 2;
  }
  if (loaded.kind === "export-missing") {
    await writeStderr(io, renderMissingExport(command));
    return 2;
  }
  if (loaded.kind === "not-an-engine") {
    await writeStderr(io, renderNotAnEngine(command));
    return 2;
  }

  const report = inspectEngine(loaded.engine, {
    mcpManifestPresent: existsSync(resolve(cwd, mcpManifestFileName)),
    composedCapabilitiesExport: hasComposedCapabilitiesExport(loaded.namespace),
  });
  await writeStderr(io, renderReport(command, report));
  return report.findings.length === 0 ? 0 : 1;
}

function renderServeFailure(command: EngineCommand, error: unknown): string {
  return renderLines([
    `${programName}: the dev server could not start.`,
    ...renderContext(command),
    describeThrownValue(error),
  ]);
}

function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolvePromise) => {
    const stop = (): void => {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      resolvePromise();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

async function runServe(
  command: ServeCommand,
  cwd: string,
  io: DevtoolsIo,
): Promise<number> {
  let serveOptions: StartServeOptions;
  if (command.buildCommand !== undefined) {
    // In watch mode the module belongs to the child host; the parent never
    // imports it, so a rebuild can only ever apply by process replacement.
    serveOptions = {
      cwd,
      watch: {
        moduleSpecifier: command.moduleSpecifier,
        exportName: command.exportName,
        buildCommand: command.buildCommand,
      },
      onDiagnostic: (text) => {
        void writeStderr(io, text);
      },
      ...(command.port === undefined ? {} : { port: command.port }),
      ...(command.enginePort === undefined
        ? {}
        : { enginePort: command.enginePort }),
    };
  } else {
    const loaded = await loadEngineModule({
      moduleSpecifier: command.moduleSpecifier,
      exportName: command.exportName,
      cwd,
    });
    if (loaded.kind === "load-failed") {
      await writeStderr(io, renderLoadFailure(command, loaded.error));
      return 2;
    }
    if (loaded.kind === "export-missing") {
      await writeStderr(io, renderMissingExport(command));
      return 2;
    }
    if (loaded.kind === "not-an-engine") {
      await writeStderr(io, renderNotAnEngine(command));
      return 2;
    }
    serveOptions = {
      engine: loaded.engine,
      cwd,
      composedCapabilitiesExport: hasComposedCapabilitiesExport(
        loaded.namespace,
      ),
      ...(command.port === undefined ? {} : { port: command.port }),
      ...(command.enginePort === undefined
        ? {}
        : { enginePort: command.enginePort }),
    };
  }

  let result: StartServeResult;
  try {
    result = await startServe(serveOptions);
  } catch (error) {
    await writeStderr(io, renderServeFailure(command, error));
    return 1;
  }
  if (result.kind === "load-error") {
    if (result.stage === "load-failed") {
      await writeStderr(io, renderLoadFailure(command, result.error));
    } else if (result.stage === "export-missing") {
      await writeStderr(io, renderMissingExport(command));
    } else {
      await writeStderr(io, renderNotAnEngine(command));
    }
    return 2;
  }
  if (result.kind === "refused") {
    await writeStderr(io, renderReport(command, result.report));
    return 1;
  }

  const address = result.handles.devtoolsAddress;
  try {
    await io.writeStdout(
      `Invokta devtools listening on http://${address.host}:${String(address.port)}/\n`,
    );
  } catch {
    // A gone stdout must not abort a running dev server.
  }
  await waitForShutdownSignal();
  await result.handles.close();
  return 0;
}

async function runOpen(command: OpenCommand, io: DevtoolsIo): Promise<number> {
  let server: Awaited<ReturnType<typeof startAttachedDevtoolsServer>>;
  try {
    server = await startAttachedDevtoolsServer({
      ...(command.port === undefined ? {} : { port: command.port }),
    });
  } catch {
    await writeStderr(
      io,
      `${programName}: the MCP workbench could not start.\n`,
    );
    return 1;
  }
  const address = server.address();
  try {
    await io.writeStdout(
      `Invokta devtools listening on http://${address.host}:${String(address.port)}/\n`,
    );
  } catch {
    // A gone stdout must not abort a running workbench.
  }
  await waitForShutdownSignal();
  try {
    await server.close();
    return 0;
  } catch {
    await writeStderr(
      io,
      `${programName}: the MCP workbench could not close cleanly.\n`,
    );
    return 1;
  }
}

/**
 * Runs `invokta-devtools` and resolves with its exit code. Diagnostics are
 * written only to `stderr`; `open` and `serve` write one ready line to
 * `stdout`.
 */
export async function runDevtoolsCli(
  options: RunDevtoolsCliOptions = {},
): Promise<number> {
  const io = resolveIo(options.io);
  const argv = options.argv ?? process.argv.slice(2);

  let command: ParsedDevtoolsCommand;
  try {
    command = parseDevtoolsCommand(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    await writeStderr(
      io,
      argv[0] === "verify"
        ? renderVerifyFailure("INVALID_TARGET")
        : renderUsageError(
            error,
            argv[0] === "doctor" || argv[0] === "serve" ? engineUsage : usage,
          ),
    );
    return 2;
  }

  const cwd = options.cwd ?? process.cwd();
  if (command.command === "serve") {
    return runServe(command, cwd, io);
  }
  if (command.command === "doctor") {
    return runDoctor(command, cwd, io);
  }
  if (command.command === "open") {
    return runOpen(command, io);
  }
  let target: ResolvedVerifyTarget;
  try {
    target = resolveVerifyTargetEnvironment(
      command,
      (name) => process.env[name],
    );
  } catch (error) {
    if (!(error instanceof VerifyEnvironmentError)) throw error;
    await writeStderr(io, renderVerifyFailure(error.code));
    return 2;
  }
  return runMcpVerification({ target, io });
}
