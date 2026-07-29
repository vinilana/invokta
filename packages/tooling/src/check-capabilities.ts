import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  isCapabilityCompositionError,
  isComposedCapabilities,
} from "@invokta/core";

export interface CheckCapabilitiesIo {
  readonly writeStderr: (text: string) => void | Promise<void>;
}

export interface CheckCapabilitiesOptions {
  /** Defaults to `process.argv.slice(2)`. */
  readonly argv?: readonly string[];
  /** Directory the module path is resolved against. Defaults to `process.cwd()`. */
  readonly cwd?: string;
  readonly io?: Partial<CheckCapabilitiesIo>;
}

interface CheckCommand {
  readonly moduleSpecifier: string;
  readonly exportName: string;
}

type UnknownRecord = Readonly<Record<string, unknown>>;

const programName = "invokta";
const defaultExportName = "capabilities";

const usage = `Usage:
  invokta check-capabilities <esm-module> [--export <name>]

The module path is resolved against the current working directory and must
already be built to ESM. The selected export defaults to "capabilities" and must
be the value returned by composeCapabilities.

Exit codes:
  0  the selected export is a valid tracked composition
  1  the composition reported issues
  2  invalid usage, a module that failed to load, a missing export, or an
     export that is not a tracked composition`;

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/**
 * Every value in a diagnostic is emitted as a JSON string literal. Capability
 * IDs and provenance strings are author-controlled, so quoting keeps a crafted
 * identifier from forging an additional diagnostic line and keeps the output
 * byte-stable for grepping.
 */
function quote(value: string): string {
  return JSON.stringify(value);
}

function asRecord(value: unknown): UnknownRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return value as UnknownRecord;
}

function token(value: unknown): string {
  return typeof value === "string" ? quote(value) : '"<unreadable>"';
}

function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function parseCommand(argv: readonly string[]): CheckCommand {
  const [command, ...args] = argv;
  if (command === undefined) throw new UsageError("A command is required.");
  if (command !== "check-capabilities") {
    throw new UsageError(`Unknown command ${quote(command)}.`);
  }

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

function renderDeclaration(declaration: unknown): string {
  const record = asRecord(declaration);
  const kind = record?.kind;
  if (kind === "local") {
    return `  declaration: kind="local" localId=${token(record?.localId)}`;
  }
  if (kind === "atomic") {
    const version = record?.sourceVersion;
    const renderedVersion =
      version === undefined ? "" : ` sourceVersion=${token(version)}`;
    return `  declaration: kind="atomic" sourceName=${token(record?.sourceName)}${renderedVersion} defaultId=${token(record?.defaultId)}`;
  }
  if (kind === "library") {
    return `  declaration: kind="library" libraryName=${token(record?.libraryName)} libraryVersion=${token(record?.libraryVersion)} defaultId=${token(record?.defaultId)}`;
  }
  return `  declaration: kind=${token(kind)}`;
}

function renderIssue(issue: unknown): readonly string[] {
  const record = asRecord(issue);
  const code = record?.code;
  if (typeof code !== "string") return [`issue: code=${token(code)}`];

  if (code === "CAPABILITY_ID_COLLISION") {
    const effectiveId = record?.effectiveId;
    const declarations = record?.declarations;
    if (typeof effectiveId !== "string" || !Array.isArray(declarations)) {
      return [`issue: code=${quote(code)}`];
    }
    return [
      `issue: code=${quote(code)} effectiveId=${quote(effectiveId)} declarations=${String(declarations.length)}`,
      ...declarations.map(renderDeclaration),
    ];
  }
  if (code === "CAPABILITY_IMPORT_INVALID") {
    return [
      `issue: code=${quote(code)} importKind=${token(record?.importKind)} reason=${token(record?.reason)}`,
    ];
  }
  if (
    code === "CAPABILITY_IMPORT_ID_NOT_FOUND" ||
    code === "CAPABILITY_REMAP_NOT_SELECTED"
  ) {
    return [
      `issue: code=${quote(code)} libraryName=${token(record?.libraryName)} defaultId=${token(record?.defaultId)}`,
    ];
  }
  return [`issue: code=${quote(code)}`];
}

/**
 * Re-applies the ordering the core already guarantees — collisions first sorted
 * by effective ID, then the remaining issues in composition order — so the
 * command's own output is deterministic without trusting the array order of an
 * error thrown by a separately resolved copy of the core.
 */
function orderIssues(issues: readonly unknown[]): readonly unknown[] {
  const collisions: unknown[] = [];
  const rest: unknown[] = [];
  for (const issue of issues) {
    const record = asRecord(issue);
    if (
      record?.code === "CAPABILITY_ID_COLLISION" &&
      typeof record.effectiveId === "string"
    ) {
      collisions.push(issue);
      continue;
    }
    rest.push(issue);
  }
  collisions.sort((left, right) =>
    compareCodeUnits(
      (asRecord(left) as UnknownRecord).effectiveId as string,
      (asRecord(right) as UnknownRecord).effectiveId as string,
    ),
  );
  return [...collisions, ...rest];
}

function renderContext(command: CheckCommand): readonly string[] {
  return [
    `module: ${quote(command.moduleSpecifier)}`,
    `export: ${quote(command.exportName)}`,
  ];
}

function renderLines(lines: readonly string[]): string {
  return `${lines.join("\n")}\n`;
}

function renderCompositionFailure(
  command: CheckCommand,
  error: unknown,
): string {
  const header = [
    `${programName}: the capability composition is invalid.`,
    ...renderContext(command),
  ];
  try {
    const issues = orderIssues(
      (asRecord(error)?.issues ?? []) as readonly unknown[],
    );
    return renderLines([
      ...header,
      `issues: ${String(issues.length)}`,
      ...issues.flatMap(renderIssue),
    ]);
  } catch {
    // A hostile diagnostic value must not replace the composition failure.
    return renderLines([...header, "issues: <unreadable>"]);
  }
}

/**
 * Describes why a module could not be evaluated. This is the failure of the
 * application build input itself, not a composition diagnostic: no composed map
 * exists yet, and the reason is the only actionable information the command
 * has. Only the error name, code, and message are echoed, never a stack.
 */
function describeThrownValue(error: unknown): string {
  try {
    if (typeof error === "string") {
      return `error: message=${quote(error)}`;
    }
    const record = asRecord(error);
    if (record === undefined) return 'error: name="<unreadable>"';
    const name = record.name;
    const code = record.code;
    const message = record.message;
    const parts = [`error: name=${token(name)}`];
    if (typeof code === "string") parts.push(`code=${quote(code)}`);
    parts.push(`message=${token(message)}`);
    return parts.join(" ");
  } catch {
    return 'error: name="<unreadable>"';
  }
}

function renderLoadFailure(command: CheckCommand, error: unknown): string {
  return renderLines([
    `${programName}: the module could not be loaded.`,
    ...renderContext(command),
    describeThrownValue(error),
  ]);
}

function renderMissingExport(command: CheckCommand): string {
  return renderLines([
    `${programName}: the module does not provide the requested export.`,
    ...renderContext(command),
    "reason: build a side-effect-free module that exports the composed capability map.",
  ]);
}

function renderUntrackedExport(command: CheckCommand): string {
  return renderLines([
    `${programName}: the selected export is not a tracked capability composition.`,
    ...renderContext(command),
    "reason: the value carries no framework composition provenance, so declaration collisions cannot be detected.",
    "reason: build the export with composeCapabilities instead of merging capability maps with object spread.",
  ]);
}

function renderUsageError(error: UsageError): string {
  return renderLines([`${programName}: ${error.message}`, "", usage]);
}

function readExport(
  namespace: object,
  exportName: string,
): { readonly found: boolean; readonly value: unknown } {
  try {
    if (!Object.hasOwn(namespace, exportName)) {
      return { found: false, value: undefined };
    }
    return {
      found: true,
      value: (namespace as UnknownRecord)[exportName],
    };
  } catch {
    // An uninitialized binding is indistinguishable from an absent one here,
    // and both are an unusable build input.
    return { found: false, value: undefined };
  }
}

function resolveIo(overrides: Partial<CheckCapabilitiesIo> | undefined) {
  return {
    writeStderr:
      overrides?.writeStderr ??
      ((text: string) => {
        process.stderr.write(text);
      }),
  };
}

async function writeStderr(
  io: CheckCapabilitiesIo,
  text: string,
): Promise<void> {
  try {
    await io.writeStderr(text);
  } catch {
    // A diagnostic destination cannot change the command's numeric result.
  }
}

/**
 * Runs `invokta check-capabilities` and resolves with its exit code.
 *
 * The command imports the requested module, which is what runs
 * `composeCapabilities`; validation is never re-implemented here. Nothing is
 * ever written to `stdout`.
 */
export async function checkCapabilities(
  options: CheckCapabilitiesOptions = {},
): Promise<number> {
  const io = resolveIo(options.io);

  let command: CheckCommand;
  try {
    command = parseCommand(options.argv ?? process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    await writeStderr(io, renderUsageError(error));
    return 2;
  }

  // A bare relative specifier would resolve against this package rather than
  // the application being checked, so it becomes an explicit file URL first.
  const moduleUrl = pathToFileURL(
    resolve(options.cwd ?? process.cwd(), command.moduleSpecifier),
  );

  let namespace: object;
  try {
    namespace = (await import(moduleUrl.href)) as object;
  } catch (error) {
    if (isCapabilityCompositionError(error)) {
      await writeStderr(io, renderCompositionFailure(command, error));
      return 1;
    }
    await writeStderr(io, renderLoadFailure(command, error));
    return 2;
  }

  const selected = readExport(namespace, command.exportName);
  if (!selected.found) {
    await writeStderr(io, renderMissingExport(command));
    return 2;
  }
  if (!isComposedCapabilities(selected.value)) {
    await writeStderr(io, renderUntrackedExport(command));
    return 2;
  }
  return 0;
}
