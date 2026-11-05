import { open, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { CapabilityMap, Engine } from "@invokta/core";

import {
  type ContractChange,
  type ContractChangeSeverity,
  type ContractDiff,
  diffContractSnapshots,
} from "./contract-diff.js";
import {
  type ContractSnapshot,
  ContractSnapshotError,
  createContractSnapshot,
  maximumSnapshotBytes,
  readContractSnapshot,
  serializeContractSnapshot,
} from "./contract-snapshot.js";

export interface ContractCommandIo {
  readonly writeStdout: (text: string) => void | Promise<void>;
  readonly writeStderr: (text: string) => void | Promise<void>;
}

export interface ContractCommandOptions {
  /** Defaults to `process.argv.slice(2)`. */
  readonly argv?: readonly string[];
  /** Directory that module and snapshot paths are resolved against. Defaults to `process.cwd()`. */
  readonly cwd?: string;
  readonly io?: Partial<ContractCommandIo>;
}

type ContractCommand =
  | {
      readonly kind: "snapshot";
      readonly moduleSpecifier: string;
      readonly exportName: string;
      readonly output?: string;
    }
  | {
      readonly kind: "diff";
      readonly previous: string;
      readonly next: string;
      readonly failOnPotentiallyBreaking: boolean;
    };

type UnknownRecord = Readonly<Record<string, unknown>>;

const defaultExportName = "engine";
const failOnPotentiallyBreakingFlag = "--fail-on-potentially-breaking";

const usage = `Usage:
  invokta contract snapshot <esm-module> [--export <name>] [--output <file>]
  invokta contract diff <previous-snapshot> <next-snapshot> [--fail-on-potentially-breaking]

snapshot writes a deterministic JSON snapshot of the selected engine's public
contract to stdout, or to --output. The module path is resolved against the
current working directory and must already be built to ESM. The selected
export defaults to "engine".

diff compares two snapshots and writes a classified report to stdout.

Exit codes:
  0  the snapshot was written, or no breaking change was found
  1  a breaking change was found, or a potentially breaking change was found
     with --fail-on-potentially-breaking
  2  invalid usage, a module that failed to load, a missing export, an export
     that is not a usable Invokta engine, or an unreadable or invalid snapshot`;

const severityHeadings: ReadonlyArray<
  readonly [ContractChangeSeverity, string]
> = [
  ["breaking", "breaking changes"],
  ["potentially-breaking", "potentially breaking changes"],
  ["compatible", "compatible changes"],
];

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

class OutputError extends Error {
  constructor(cause: unknown) {
    super("The command output could not be written.", { cause });
    this.name = "OutputError";
  }
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function asRecord(value: unknown): UnknownRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return value as UnknownRecord;
}

function renderLines(lines: readonly string[]): string {
  return `${lines.join("\n")}\n`;
}

function readOptionValue(
  args: readonly string[],
  index: number,
  option: string,
  description: string,
): string {
  const value = args[index + 1];
  if (value === undefined || value === "" || value.startsWith("-")) {
    throw new UsageError(`The ${option} option requires ${description}.`);
  }
  return value;
}

function parseSnapshot(args: readonly string[]): ContractCommand {
  let moduleSpecifier: string | undefined;
  let exportName: string | undefined;
  let output: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument === "--export" || argument === "--output") {
      const seen = argument === "--export" ? exportName : output;
      if (seen !== undefined) {
        throw new UsageError(
          `The ${argument} option must be provided at most once.`,
        );
      }
      const value = readOptionValue(
        args,
        index,
        argument,
        argument === "--export" ? "a name" : "a file path",
      );
      if (argument === "--export") exportName = value;
      else output = value;
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
  return {
    kind: "snapshot",
    moduleSpecifier,
    exportName: exportName ?? defaultExportName,
    ...(output === undefined ? {} : { output }),
  };
}

function parseDiff(args: readonly string[]): ContractCommand {
  const paths: string[] = [];
  let failOnPotentiallyBreaking = false;
  for (const argument of args) {
    if (argument === failOnPotentiallyBreakingFlag) {
      if (failOnPotentiallyBreaking) {
        throw new UsageError(
          `The ${failOnPotentiallyBreakingFlag} option must be provided at most once.`,
        );
      }
      failOnPotentiallyBreaking = true;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new UsageError(`Unknown option ${quote(argument)}.`);
    }
    if (argument === "") {
      throw new UsageError("A snapshot path must not be empty.");
    }
    paths.push(argument);
  }
  const [previous, next] = paths;
  if (paths.length !== 2 || previous === undefined || next === undefined) {
    throw new UsageError("Exactly two snapshot paths are required.");
  }
  return { kind: "diff", previous, next, failOnPotentiallyBreaking };
}

function parseCommand(argv: readonly string[]): ContractCommand {
  const [command, subcommand, ...args] = argv;
  if (command === undefined) throw new UsageError("A command is required.");
  if (command !== "contract") {
    throw new UsageError(`Unknown command ${quote(command)}.`);
  }
  if (subcommand === undefined) {
    throw new UsageError("A contract command is required.");
  }
  if (subcommand === "snapshot") return parseSnapshot(args);
  if (subcommand === "diff") return parseDiff(args);
  throw new UsageError(`Unknown contract command ${quote(subcommand)}.`);
}

function resolveIo(
  overrides: Partial<ContractCommandIo> | undefined,
): ContractCommandIo {
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

async function writeStdout(io: ContractCommandIo, text: string): Promise<void> {
  try {
    await io.writeStdout(text);
  } catch (cause) {
    throw new OutputError(cause);
  }
}

async function writeStderr(io: ContractCommandIo, text: string): Promise<void> {
  try {
    await io.writeStderr(text);
  } catch {
    // A diagnostic destination cannot change the command's numeric result.
  }
}

function isUsableEngine(value: unknown): value is Engine<CapabilityMap> {
  const record = asRecord(value);
  return (
    typeof record?.name === "string" &&
    typeof record.version === "string" &&
    typeof record.list === "function" &&
    typeof record.describe === "function" &&
    typeof record.invoke === "function"
  );
}

function readExport(
  namespace: object,
  exportName: string,
): { readonly found: boolean; readonly value: unknown } {
  try {
    if (!Object.hasOwn(namespace, exportName)) {
      return { found: false, value: undefined };
    }
    return { found: true, value: (namespace as UnknownRecord)[exportName] };
  } catch {
    return { found: false, value: undefined };
  }
}

async function snapshotCommand(
  command: Extract<ContractCommand, { kind: "snapshot" }>,
  cwd: string,
  io: ContractCommandIo,
): Promise<number> {
  const context = [
    `module: ${quote(command.moduleSpecifier)}`,
    `export: ${quote(command.exportName)}`,
  ];
  const moduleUrl = pathToFileURL(resolve(cwd, command.moduleSpecifier));
  let namespace: object;
  try {
    namespace = (await import(moduleUrl.href)) as object;
  } catch {
    await writeStderr(
      io,
      renderLines(["invokta: the module could not be loaded.", ...context]),
    );
    return 2;
  }
  const selected = readExport(namespace, command.exportName);
  if (!selected.found) {
    await writeStderr(
      io,
      renderLines([
        "invokta: the module does not provide the requested export.",
        ...context,
      ]),
    );
    return 2;
  }
  if (!isUsableEngine(selected.value)) {
    await writeStderr(
      io,
      renderLines([
        "invokta: the selected export is not a usable Invokta engine.",
        ...context,
        "reason: export the engine created by createEngine from a side-effect-free module.",
      ]),
    );
    return 2;
  }

  let text: string;
  try {
    text = serializeContractSnapshot(createContractSnapshot(selected.value));
    if (Buffer.byteLength(text, "utf8") > maximumSnapshotBytes) {
      throw new ContractSnapshotError(
        `the snapshot exceeds the ${String(maximumSnapshotBytes)}-byte limit.`,
      );
    }
  } catch (error) {
    // Only the snapshot format's own messages are echoed; an engine failure
    // may carry application data and is reduced to a generic reason.
    const reason =
      error instanceof ContractSnapshotError
        ? error.message
        : "the engine failed while describing its capabilities.";
    await writeStderr(
      io,
      renderLines([
        "invokta: the engine contract could not be captured.",
        ...context,
        `reason: ${reason}`,
      ]),
    );
    return 2;
  }

  if (command.output === undefined) {
    await writeStdout(io, text);
    return 0;
  }
  try {
    await writeFile(resolve(cwd, command.output), text, "utf8");
  } catch {
    await writeStderr(
      io,
      renderLines([
        "invokta: the contract snapshot could not be written.",
        `file: ${quote(command.output)}`,
      ]),
    );
    return 2;
  }
  return 0;
}

type SnapshotRead =
  | { readonly ok: true; readonly snapshot: ContractSnapshot }
  | { readonly ok: false; readonly reason: string };

async function readSnapshotFile(path: string): Promise<SnapshotRead> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "r");
  } catch {
    return { ok: false, reason: "the file could not be read." };
  }
  let bytes: Buffer;
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      return { ok: false, reason: "the file could not be read." };
    }
    if (stats.size > maximumSnapshotBytes) {
      return {
        ok: false,
        reason: `the file exceeds the ${String(maximumSnapshotBytes)}-byte snapshot limit.`,
      };
    }
    // One spare byte detects a file that grew after it was measured.
    const capacity = stats.size + 1;
    const buffer = Buffer.alloc(capacity);
    let length = 0;
    while (length < capacity) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        capacity - length,
        length,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length === capacity) {
      return { ok: false, reason: "the file changed while it was read." };
    }
    bytes = buffer.subarray(0, length);
  } catch {
    return { ok: false, reason: "the file could not be read." };
  } finally {
    await handle.close().catch(() => undefined);
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "the file is not valid UTF-8." };
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    // The parser's message can quote file content, so it is never echoed.
    return { ok: false, reason: "the file is not valid JSON." };
  }
  try {
    return { ok: true, snapshot: readContractSnapshot(value) };
  } catch (error) {
    if (error instanceof ContractSnapshotError) {
      return { ok: false, reason: error.message };
    }
    throw error;
  }
}

function renderEngine(label: string, snapshot: ContractSnapshot): string {
  return `${label}: engine=${quote(snapshot.engine.name)} version=${quote(snapshot.engine.version)} capabilities=${String(Object.keys(snapshot.capabilities).length)}`;
}

function renderChange(change: ContractChange): string {
  const capability =
    change.capabilityId === undefined
      ? ""
      : ` capability=${quote(change.capabilityId)}`;
  const location =
    change.schema === undefined
      ? ""
      : ` at=${quote(`${change.schema}#${change.path ?? ""}`)}`;
  return `  ${change.code}${capability}${location}: ${change.message}`;
}

function renderResult(diff: ContractDiff, failOnPotentiallyBreaking: boolean) {
  if (diff.breaking > 0) return "result: breaking changes found";
  if (diff.potentiallyBreaking > 0) {
    return failOnPotentiallyBreaking
      ? "result: potentially breaking changes found"
      : "result: no breaking changes; review the potentially breaking changes";
  }
  return "result: compatible";
}

function renderReport(
  previous: ContractSnapshot,
  next: ContractSnapshot,
  diff: ContractDiff,
  failOnPotentiallyBreaking: boolean,
): string {
  const lines = [
    "invokta: contract diff",
    renderEngine("previous", previous),
    renderEngine("next", next),
    "",
  ];
  if (diff.changes.length === 0) lines.push("no contract changes", "");
  for (const [severity, heading] of severityHeadings) {
    const changes = diff.changes.filter(
      (change) => change.severity === severity,
    );
    if (changes.length === 0) continue;
    lines.push(
      `${heading}: ${String(changes.length)}`,
      ...changes.map(renderChange),
      "",
    );
  }
  lines.push(renderResult(diff, failOnPotentiallyBreaking));
  return renderLines(lines);
}

async function diffCommand(
  command: Extract<ContractCommand, { kind: "diff" }>,
  cwd: string,
  io: ContractCommandIo,
): Promise<number> {
  const snapshots: ContractSnapshot[] = [];
  for (const [label, path] of [
    ["previous", command.previous],
    ["next", command.next],
  ] as const) {
    const read = await readSnapshotFile(resolve(cwd, path));
    if (!read.ok) {
      await writeStderr(
        io,
        renderLines([
          `invokta: the ${label} snapshot could not be read.`,
          `file: ${quote(path)}`,
          `reason: ${read.reason}`,
        ]),
      );
      return 2;
    }
    snapshots.push(read.snapshot);
  }
  const [previous, next] = snapshots as [ContractSnapshot, ContractSnapshot];
  const diff = diffContractSnapshots(previous, next);
  await writeStdout(
    io,
    renderReport(previous, next, diff, command.failOnPotentiallyBreaking),
  );
  if (diff.breaking > 0) return 1;
  return command.failOnPotentiallyBreaking && diff.potentiallyBreaking > 0
    ? 1
    : 0;
}

/**
 * Runs `invokta contract snapshot` or `invokta contract diff` and resolves
 * with the exit code. It never invokes a capability or starts an adapter.
 */
export async function runContractCommand(
  options: ContractCommandOptions = {},
): Promise<number> {
  const io = resolveIo(options.io);
  const cwd = options.cwd ?? process.cwd();
  let command: ContractCommand;
  try {
    command = parseCommand(options.argv ?? process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    await writeStderr(
      io,
      renderLines([`invokta: ${error.message}`, "", usage]),
    );
    return 2;
  }
  try {
    return command.kind === "snapshot"
      ? await snapshotCommand(command, cwd, io)
      : await diffCommand(command, cwd, io);
  } catch (error) {
    if (!(error instanceof OutputError)) throw error;
    await writeStderr(
      io,
      "invokta: the command output could not be written.\n",
    );
    return 2;
  }
}
