import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { isComposedCapabilities } from "@invokta/core";

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
import { loadEngineModule } from "./load-engine.js";
import type { StartServeResult } from "./serve.js";
import { startServe } from "./serve.js";

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

interface DoctorCommand {
  readonly command: "doctor";
  readonly moduleSpecifier: string;
  readonly exportName: string;
}

interface ServeCommand {
  readonly command: "serve";
  readonly moduleSpecifier: string;
  readonly exportName: string;
  readonly port?: number;
  readonly enginePort?: number;
}

type DevtoolsCommand = DoctorCommand | ServeCommand;

const defaultExportName = "engine";
const mcpManifestFileName = "invokta.mcp.json";
const composedExportName = "capabilities";

const usage = `Usage:
  invokta-devtools doctor <esm-module> [--export <name>]
  invokta-devtools serve <esm-module> [--export <name>] [--port <number>]
    [--engine-port <number>]

The module path is resolved against the current working directory and must
already be built to ESM. The selected export defaults to "engine" and must be
the value returned by createEngine.

serve preflights the engine with the doctor checks, hosts it with the MCP
HTTP adapter on loopback, and serves the development interface on
http://127.0.0.1:4100/ unless --port selects another loopback port.

Exit codes:
  0  the engine passed the doctor checks, or the dev server shut down cleanly
  1  the doctor reported findings, or the dev server could not start
  2  invalid usage, a module that failed to load, a missing export, or an
     export that is not an engine`;

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

function parseServeArguments(
  args: readonly string[],
): Omit<ServeCommand, "command"> {
  const positional: string[] = [];
  let exportName: string | undefined;
  let port: number | undefined;
  let enginePort: number | undefined;
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
  return {
    moduleSpecifier: positional[0] as string,
    exportName: exportName ?? defaultExportName,
    ...(port === undefined ? {} : { port }),
    ...(enginePort === undefined ? {} : { enginePort }),
  };
}

function parseCommand(argv: readonly string[]): DevtoolsCommand {
  const [command, ...args] = argv;
  if (command === undefined) throw new UsageError("A command is required.");
  if (command === "doctor") {
    return { command: "doctor", ...parseModuleArguments(args) };
  }
  if (command === "serve") {
    return { command: "serve", ...parseServeArguments(args) };
  }
  throw new UsageError(`Unknown command ${quote(command)}.`);
}

function renderContext(command: DevtoolsCommand): readonly string[] {
  return [
    `module: ${quote(command.moduleSpecifier)}`,
    `export: ${quote(command.exportName)}`,
  ];
}

function renderUsageError(error: UsageError): string {
  return renderLines([`${programName}: ${error.message}`, "", usage]);
}

function renderLoadFailure(command: DevtoolsCommand, error: unknown): string {
  return renderLines([
    `${programName}: the module could not be loaded.`,
    ...renderContext(command),
    describeThrownValue(error),
  ]);
}

function renderMissingExport(command: DevtoolsCommand): string {
  return renderLines([
    `${programName}: the module does not provide the requested export.`,
    ...renderContext(command),
    "reason: build the engine module and export the value returned by createEngine.",
  ]);
}

function renderNotAnEngine(command: DevtoolsCommand): string {
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

function renderReport(command: DevtoolsCommand, report: DoctorReport): string {
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

function hasComposedCapabilitiesExport(namespace: object): boolean {
  try {
    if (!Object.hasOwn(namespace, composedExportName)) return false;
    return isComposedCapabilities(
      (namespace as Readonly<Record<string, unknown>>)[composedExportName],
    );
  } catch {
    return false;
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

function renderServeFailure(command: DevtoolsCommand, error: unknown): string {
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

  let result: StartServeResult;
  try {
    result = await startServe({
      engine: loaded.engine,
      cwd,
      composedCapabilitiesExport: hasComposedCapabilitiesExport(
        loaded.namespace,
      ),
      ...(command.port === undefined ? {} : { port: command.port }),
      ...(command.enginePort === undefined
        ? {}
        : { enginePort: command.enginePort }),
    });
  } catch (error) {
    await writeStderr(io, renderServeFailure(command, error));
    return 1;
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

/**
 * Runs `invokta-devtools` and resolves with its exit code. Diagnostics are
 * written only to `stderr`; `serve` writes its single ready line to `stdout`.
 */
export async function runDevtoolsCli(
  options: RunDevtoolsCliOptions = {},
): Promise<number> {
  const io = resolveIo(options.io);

  let command: DevtoolsCommand;
  try {
    command = parseCommand(options.argv ?? process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    await writeStderr(io, renderUsageError(error));
    return 2;
  }

  const cwd = options.cwd ?? process.cwd();
  if (command.command === "serve") {
    return runServe(command, cwd, io);
  }
  return runDoctor(command, cwd, io);
}
