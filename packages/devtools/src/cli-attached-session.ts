import type { ChildProcess } from "node:child_process";
import { spawn as defaultSpawn } from "node:child_process";
import { types as nodeTypes } from "node:util";

export const ATTACHED_CLI_SESSION_LIMITS = Object.freeze({
  listTimeoutMs: 15_000,
  describeTimeoutMs: 15_000,
  runTimeoutMs: 60_000,
  streamBytes: 10 * 1024 * 1024,
  catalogSummaries: 2_000,
  inputArgumentBytes: 98_304,
  activityRecords: 500,
  retainedActivityRecords: 50,
  displayedNameCodePoints: 256,
});

export type AttachedCliSessionErrorCode =
  | "INVALID_TARGET"
  | "SPAWN_FAILED"
  | "CONNECTION_FAILED"
  | "PROTOCOL_ERROR"
  | "TIMEOUT"
  | "LIMIT_EXCEEDED"
  | "TARGET_BUSY"
  | "NOT_CONNECTED"
  | "ENVIRONMENT_VALUE_MISSING";

const errorMessages = {
  INVALID_TARGET: "The CLI target descriptor is invalid.",
  SPAWN_FAILED: "The CLI process could not be started.",
  CONNECTION_FAILED: "The CLI connection failed.",
  PROTOCOL_ERROR: "The CLI returned an invalid document.",
  TIMEOUT: "The CLI operation timed out.",
  LIMIT_EXCEEDED: "The CLI operation exceeded a configured limit.",
  TARGET_BUSY: "Another target or CLI verb is already active.",
  NOT_CONNECTED: "No CLI target is connected.",
  ENVIRONMENT_VALUE_MISSING: "A required environment value is missing.",
} as const satisfies Record<AttachedCliSessionErrorCode, string>;

const unixDefaultEnvNames = [
  "HOME",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TERM",
  "USER",
] as const;

const windowsDefaultEnvNames = [
  "APPDATA",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "PATH",
  "PROCESSOR_ARCHITECTURE",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "USERNAME",
  "USERPROFILE",
  "PROGRAMFILES",
] as const;

const environmentNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const annotationKeys = [
  "readOnly",
  "destructive",
  "idempotent",
  "openWorld",
] as const;
const defaultKillGraceMs = 3_000;
const deadlineReason = Object.freeze({ type: "attached-cli-deadline" });
const disconnectReason = Object.freeze({ type: "attached-cli-disconnect" });

export class AttachedCliSessionError extends Error {
  declare readonly code: AttachedCliSessionErrorCode;
  declare readonly message: string;

  constructor(code: AttachedCliSessionErrorCode, options?: ErrorOptions) {
    super();
    Object.defineProperties(this, {
      code: {
        configurable: false,
        enumerable: true,
        value: code,
        writable: false,
      },
      message: {
        configurable: false,
        enumerable: true,
        value: errorMessages[code],
        writable: false,
      },
      ...(options?.cause === undefined
        ? {}
        : {
            cause: {
              configurable: false,
              enumerable: false,
              value: options.cause,
              writable: false,
            },
          }),
    });
  }
}

export interface AttachedCliAnnotations {
  readonly readOnly?: boolean;
  readonly destructive?: boolean;
  readonly idempotent?: boolean;
  readonly openWorld?: boolean;
}

export interface AttachedCliCapabilitySummary {
  readonly id: string;
  readonly description: string;
  readonly title?: string;
  readonly annotations?: AttachedCliAnnotations;
}

export interface AttachedCliCapabilityDescription
  extends AttachedCliCapabilitySummary {
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly timeoutMs?: number;
}

export interface AttachedCliActivityRecord {
  readonly sequence: number;
  readonly operation: "list" | "describe" | "run" | "disconnect";
  readonly startedAt: string;
  readonly durationMs: number;
  readonly outcome: "success" | "error";
  readonly errorCode?: AttachedCliSessionErrorCode;
  readonly capabilityId?: string;
  readonly exitCode?: number | null;
}

export interface AttachedCliConnectionSummary {
  readonly command: string;
  readonly capabilityCount: number;
  readonly validation: { readonly status: "ok" };
}

export type AttachedCliSessionState =
  | {
      readonly state: "idle";
      readonly validation?: {
        readonly status: "error";
        readonly error: {
          readonly code: AttachedCliSessionErrorCode;
          readonly message: string;
        };
      };
      readonly activity?: readonly AttachedCliActivityRecord[];
    }
  | { readonly state: "busy" }
  | { readonly state: "connecting" }
  | {
      readonly state: "connected";
      readonly connection: AttachedCliConnectionSummary;
    }
  | { readonly state: "closing" };

export interface AttachedCliSessionClock {
  now(): number;
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface AttachedCliSpawnOptions {
  readonly cwd?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly shell: false;
  readonly stdio: readonly ["ignore", "pipe", "pipe"];
}

export type AttachedCliSpawn = (
  command: string,
  args: readonly string[],
  options: AttachedCliSpawnOptions,
) => ChildProcess;

export interface CreateAttachedCliSessionControllerOptions {
  readonly spawn?: AttachedCliSpawn;
  readonly clock?: AttachedCliSessionClock;
  readonly killGraceMs?: number;
  readonly platform?: NodeJS.Platform;
  readonly readHostEnv?: (name: string) => string | undefined;
}

export interface AttachedCliSessionController {
  connect(
    owner: string,
    target: unknown,
  ): Promise<AttachedCliConnectionSummary>;
  refresh(owner: string): Promise<AttachedCliConnectionSummary>;
  describe(
    owner: string,
    id: string,
  ): Promise<AttachedCliCapabilityDescription>;
  run(owner: string, id: string, input: unknown): Promise<unknown>;
  state(owner: string): AttachedCliSessionState;
  catalog(owner: string): readonly AttachedCliCapabilitySummary[];
  description(owner: string): AttachedCliCapabilityDescription | undefined;
  activity(owner: string): readonly AttachedCliActivityRecord[];
  disconnect(owner: string): Promise<void>;
  close(): Promise<void>;
}

interface ParsedCliTarget {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly overlay: Readonly<Record<string, string>>;
}

interface ActivityStore {
  append(
    record: Omit<AttachedCliActivityRecord, "sequence">,
  ): AttachedCliActivityRecord;
  entries(): readonly AttachedCliActivityRecord[];
  clear(): void;
}

interface ActiveSlot {
  readonly owner: string;
  readonly target: ParsedCliTarget;
  readonly activity: ActivityStore;
  state: "connecting" | "connected" | "closing";
  catalog: readonly AttachedCliCapabilitySummary[];
  described: AttachedCliCapabilityDescription | undefined;
  verbAbort: AbortController | undefined;
  verbActive: boolean;
  verbPromise: Promise<unknown> | undefined;
  connectionSummary: AttachedCliConnectionSummary | undefined;
}

interface LastValidationFailure {
  readonly owner: string;
  readonly code: AttachedCliSessionErrorCode;
  readonly message: string;
}

interface RetainedActivity {
  readonly owner: string;
  readonly records: readonly AttachedCliActivityRecord[];
}

interface ChildResult {
  readonly exitCode: number | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

const defaultClock: AttachedCliSessionClock = {
  now: () => Date.now(),
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function attachedError(
  code: AttachedCliSessionErrorCode,
  cause?: unknown,
): AttachedCliSessionError {
  return new AttachedCliSessionError(
    code,
    cause === undefined ? undefined : { cause },
  );
}

function createActivityStore(): ActivityStore {
  const records: AttachedCliActivityRecord[] = [];
  let nextSequence = 0;
  return {
    append: (record) => {
      nextSequence += 1;
      const stored = Object.freeze({ sequence: nextSequence, ...record });
      records.push(stored);
      if (records.length > ATTACHED_CLI_SESSION_LIMITS.activityRecords) {
        records.shift();
      }
      return stored;
    },
    entries: () => Object.freeze([...records]),
    clear: () => {
      records.length = 0;
    },
  };
}

function ownDataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor)) return undefined;
  return descriptor.value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function duration(clock: AttachedCliSessionClock, started: number): number {
  return Math.max(0, clock.now() - started);
}

function startedAt(started: number): string {
  try {
    return new Date(started).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

function boundedCapabilityId(id: string): string {
  return Array.from(id)
    .slice(0, ATTACHED_CLI_SESSION_LIMITS.displayedNameCodePoints)
    .join("");
}

function defaultEnvironment(
  platform: NodeJS.Platform,
  readHostEnv: (name: string) => string | undefined,
): Record<string, string> {
  const names =
    platform === "win32" ? windowsDefaultEnvNames : unixDefaultEnvNames;
  const env = Object.create(null) as Record<string, string>;
  for (const name of names) {
    const value = readHostEnv(name);
    if (typeof value !== "string" || value.startsWith("()")) continue;
    Object.defineProperty(env, name, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
  }
  return env;
}

function composeEnvironment(
  overlay: Readonly<Record<string, string>>,
  platform: NodeJS.Platform,
  readHostEnv: (name: string) => string | undefined,
): Record<string, string> {
  const env = defaultEnvironment(platform, readHostEnv);
  for (const name of Object.keys(overlay)) {
    Object.defineProperty(env, name, {
      configurable: true,
      enumerable: true,
      value: overlay[name],
      writable: true,
    });
  }
  return env;
}

function parseTarget(value: unknown): ParsedCliTarget {
  if (
    typeof value !== "object" ||
    value === null ||
    nodeTypes.isProxy(value) ||
    Array.isArray(value)
  ) {
    throw attachedError("INVALID_TARGET");
  }
  const command = ownDataProperty(value, "command");
  if (typeof command !== "string" || command.trim() === "") {
    throw attachedError("INVALID_TARGET");
  }
  const rawArgs = ownDataProperty(value, "args");
  let args: readonly string[] = [];
  if (rawArgs !== undefined) {
    if (
      !Array.isArray(rawArgs) ||
      rawArgs.some((entry) => typeof entry !== "string")
    ) {
      throw attachedError("INVALID_TARGET");
    }
    args = rawArgs;
  }
  const cwd = ownDataProperty(value, "cwd");
  if (cwd !== undefined && (typeof cwd !== "string" || cwd.trim() === "")) {
    throw attachedError("INVALID_TARGET");
  }
  const rawEnv = ownDataProperty(value, "env");
  const overlay = Object.create(null) as Record<string, string>;
  if (rawEnv !== undefined) {
    if (!isPlainRecord(rawEnv) || nodeTypes.isProxy(rawEnv)) {
      throw attachedError("INVALID_TARGET");
    }
    for (const name of Object.keys(rawEnv)) {
      if (!environmentNamePattern.test(name)) {
        throw attachedError("INVALID_TARGET");
      }
      const entry = ownDataProperty(rawEnv, name);
      if (typeof entry !== "string") throw attachedError("INVALID_TARGET");
      if (entry === "") throw attachedError("ENVIRONMENT_VALUE_MISSING");
      Object.defineProperty(overlay, name, {
        configurable: true,
        enumerable: true,
        value: entry,
        writable: true,
      });
    }
  }
  return {
    command,
    args,
    ...(typeof cwd === "string" ? { cwd } : {}),
    overlay,
  };
}

function parseOneJson(buffer: Buffer): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw attachedError("PROTOCOL_ERROR");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw attachedError("PROTOCOL_ERROR");
  }
}

function parseAnnotations(value: unknown): AttachedCliAnnotations | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) throw attachedError("PROTOCOL_ERROR");
  const annotations: Record<string, boolean> = {};
  for (const key of annotationKeys) {
    const entry = ownDataProperty(value, key);
    if (entry === undefined) continue;
    if (typeof entry !== "boolean") throw attachedError("PROTOCOL_ERROR");
    annotations[key] = entry;
  }
  return Object.keys(annotations).length === 0
    ? {}
    : (annotations as AttachedCliAnnotations);
}

function parseSummary(value: unknown): AttachedCliCapabilitySummary {
  if (!isPlainRecord(value)) throw attachedError("PROTOCOL_ERROR");
  const id = ownDataProperty(value, "id");
  const description = ownDataProperty(value, "description");
  if (typeof id !== "string" || id === "") {
    throw attachedError("PROTOCOL_ERROR");
  }
  if (typeof description !== "string") throw attachedError("PROTOCOL_ERROR");
  const title = ownDataProperty(value, "title");
  if (title !== undefined && typeof title !== "string") {
    throw attachedError("PROTOCOL_ERROR");
  }
  const annotations = parseAnnotations(ownDataProperty(value, "annotations"));
  return {
    id,
    description,
    ...(title === undefined ? {} : { title }),
    ...(annotations === undefined ? {} : { annotations }),
  };
}

function parseCatalog(buffer: Buffer): readonly AttachedCliCapabilitySummary[] {
  const document = parseOneJson(buffer);
  if (!Array.isArray(document)) throw attachedError("PROTOCOL_ERROR");
  if (document.length > ATTACHED_CLI_SESSION_LIMITS.catalogSummaries) {
    throw attachedError("LIMIT_EXCEEDED");
  }
  return Object.freeze(document.map((entry) => parseSummary(entry)));
}

function parseDescription(buffer: Buffer): AttachedCliCapabilityDescription {
  const document = parseOneJson(buffer);
  if (!isPlainRecord(document)) throw attachedError("PROTOCOL_ERROR");
  const summary = parseSummary(document);
  const inputSchema = ownDataProperty(document, "inputSchema");
  const outputSchema = ownDataProperty(document, "outputSchema");
  if (
    !isPlainRecord(inputSchema) ||
    !isPlainRecord(outputSchema) ||
    Array.isArray(inputSchema) ||
    Array.isArray(outputSchema)
  ) {
    throw attachedError("PROTOCOL_ERROR");
  }
  const timeoutMs = ownDataProperty(document, "timeoutMs");
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs))
  ) {
    throw attachedError("PROTOCOL_ERROR");
  }
  return {
    ...summary,
    inputSchema,
    outputSchema,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

function encodeRunInput(input: unknown): string {
  let encoded: string;
  try {
    encoded = JSON.stringify(input);
  } catch {
    throw attachedError("INVALID_TARGET");
  }
  if (typeof encoded !== "string") throw attachedError("INVALID_TARGET");
  if (
    Buffer.byteLength(encoded, "utf8") >
    ATTACHED_CLI_SESSION_LIMITS.inputArgumentBytes
  ) {
    throw attachedError("LIMIT_EXCEEDED");
  }
  return encoded;
}

function connectionSummary(
  target: ParsedCliTarget,
  catalog: readonly AttachedCliCapabilitySummary[],
): AttachedCliConnectionSummary {
  return Object.freeze({
    command: target.command,
    capabilityCount: catalog.length,
    validation: Object.freeze({ status: "ok" as const }),
  });
}

function killChild(
  child: ChildProcess,
  clock: AttachedCliSessionClock,
  graceMs: number,
): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const handle = clock.schedule(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }, graceMs);
  child.once("exit", () => {
    clock.cancel(handle);
  });
}

function collectChild(
  spawn: AttachedCliSpawn,
  target: ParsedCliTarget,
  verbArgs: readonly string[],
  env: Record<string, string>,
  clock: AttachedCliSessionClock,
  killGraceMs: number,
  signal: AbortSignal,
): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let overflow = false;
    let child: ChildProcess;
    try {
      child = spawn(target.command, [...target.args, ...verbArgs], {
        ...(target.cwd === undefined ? {} : { cwd: target.cwd }),
        env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (cause) {
      reject(attachedError("SPAWN_FAILED", cause));
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;

    const finish = (
      error?: AttachedCliSessionError,
      result?: ChildResult,
    ): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (error !== undefined) reject(error);
      else if (result !== undefined) resolve(result);
    };

    const onAbort = (): void => {
      killChild(child, clock, killGraceMs);
    };

    const onChunk = (
      stream: "stdout" | "stderr",
      value: Buffer | string,
    ): void => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (stream === "stdout") {
        if (
          stdoutBytes + chunk.length >
          ATTACHED_CLI_SESSION_LIMITS.streamBytes
        ) {
          overflow = true;
          killChild(child, clock, killGraceMs);
          return;
        }
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
        return;
      }
      if (
        stderrBytes + chunk.length >
        ATTACHED_CLI_SESSION_LIMITS.streamBytes
      ) {
        overflow = true;
        killChild(child, clock, killGraceMs);
        return;
      }
      stderrChunks.push(chunk);
      stderrBytes += chunk.length;
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      onChunk("stdout", chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      onChunk("stderr", chunk);
    });
    child.once("error", (cause) => {
      finish(attachedError("SPAWN_FAILED", cause));
    });
    child.once("exit", (code) => {
      if (overflow) {
        finish(attachedError("LIMIT_EXCEEDED"));
        return;
      }
      if (signal.aborted) {
        finish(
          attachedError(
            signal.reason === deadlineReason ? "TIMEOUT" : "NOT_CONNECTED",
          ),
        );
        return;
      }
      finish(undefined, {
        exitCode: code,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
      });
    });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function runWithDeadline<Value>(
  clock: AttachedCliSessionClock,
  timeoutMs: number,
  controller: AbortController,
  operation: (signal: AbortSignal) => Promise<Value>,
): Promise<Value> {
  return new Promise<Value>((resolve, reject) => {
    let settled = false;
    let handle: unknown;
    const cleanup = (): void => {
      clock.cancel(handle);
      controller.signal.removeEventListener("abort", onAbort);
    };
    const fail = (error: AttachedCliSessionError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      fail(
        attachedError(
          controller.signal.reason === deadlineReason
            ? "TIMEOUT"
            : "NOT_CONNECTED",
        ),
      );
    };
    controller.signal.addEventListener("abort", onAbort, { once: true });
    handle = clock.schedule(() => {
      if (settled) return;
      settled = true;
      cleanup();
      controller.abort(deadlineReason);
      reject(attachedError("TIMEOUT"));
    }, timeoutMs);

    let pending: Promise<Value>;
    try {
      pending = operation(controller.signal);
    } catch (cause) {
      fail(
        cause instanceof AttachedCliSessionError
          ? cause
          : attachedError("SPAWN_FAILED", cause),
      );
      return;
    }
    void pending.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (cause: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(
          cause instanceof AttachedCliSessionError
            ? cause
            : attachedError("CONNECTION_FAILED", cause),
        );
      },
    );
  });
}

export function createAttachedCliSessionController(
  options: CreateAttachedCliSessionControllerOptions = {},
): AttachedCliSessionController {
  const spawn: AttachedCliSpawn =
    options.spawn ??
    ((command, args, spawnOptions) =>
      defaultSpawn(command, [...args], {
        ...(spawnOptions.cwd === undefined ? {} : { cwd: spawnOptions.cwd }),
        env: spawnOptions.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      }));
  const clock = options.clock ?? defaultClock;
  const killGraceMs = options.killGraceMs ?? defaultKillGraceMs;
  const platform = options.platform ?? process.platform;
  const readHostEnv =
    options.readHostEnv ?? ((name: string) => process.env[name]);
  let active: ActiveSlot | undefined;
  let lastValidationFailure: LastValidationFailure | undefined;
  let retainedActivity: RetainedActivity | undefined;

  const appendActivity = (
    slot: ActiveSlot,
    operation: AttachedCliActivityRecord["operation"],
    started: number,
    outcome: "success" | "error",
    extras: {
      readonly errorCode?: AttachedCliSessionErrorCode;
      readonly capabilityId?: string;
      readonly exitCode?: number | null;
    } = {},
  ): void => {
    slot.activity.append({
      operation,
      startedAt: startedAt(started),
      durationMs: duration(clock, started),
      outcome,
      ...(extras.errorCode === undefined
        ? {}
        : { errorCode: extras.errorCode }),
      ...(extras.capabilityId === undefined
        ? {}
        : { capabilityId: boundedCapabilityId(extras.capabilityId) }),
      ...(extras.exitCode === undefined ? {} : { exitCode: extras.exitCode }),
    });
  };

  const clearSlot = (slot: ActiveSlot): void => {
    const records = slot.activity
      .entries()
      .slice(-ATTACHED_CLI_SESSION_LIMITS.retainedActivityRecords);
    retainedActivity =
      records.length === 0 ? undefined : { owner: slot.owner, records };
    slot.catalog = Object.freeze([]);
    slot.described = undefined;
    slot.connectionSummary = undefined;
    slot.activity.clear();
    slot.verbAbort = undefined;
    slot.verbActive = false;
    if (active === slot) active = undefined;
  };

  const failConnection = (
    slot: ActiveSlot,
    failure: AttachedCliSessionError,
  ): void => {
    if (active !== slot || slot.state === "closing") return;
    clearSlot(slot);
    lastValidationFailure = {
      owner: slot.owner,
      code: failure.code,
      message: failure.message,
    };
  };

  const requireOwner = (owner: string, connected: boolean): ActiveSlot => {
    if (active === undefined) throw attachedError("NOT_CONNECTED");
    if (active.owner !== owner) throw attachedError("TARGET_BUSY");
    if (active.verbActive) throw attachedError("TARGET_BUSY");
    if (connected && active.state !== "connected") {
      throw attachedError("NOT_CONNECTED");
    }
    return active;
  };

  const runVerb = async (
    slot: ActiveSlot,
    verbArgs: readonly string[],
    timeoutMs: number,
  ): Promise<ChildResult> => {
    if (slot.verbActive) throw attachedError("TARGET_BUSY");
    slot.verbActive = true;
    const controller = new AbortController();
    slot.verbAbort = controller;
    const env = composeEnvironment(slot.target.overlay, platform, readHostEnv);
    const pending = runWithDeadline(clock, timeoutMs, controller, (signal) =>
      collectChild(
        spawn,
        slot.target,
        verbArgs,
        env,
        clock,
        killGraceMs,
        signal,
      ),
    );
    slot.verbPromise = pending;
    try {
      return await pending;
    } finally {
      slot.verbActive = false;
      slot.verbAbort = undefined;
      slot.verbPromise = undefined;
    }
  };

  const runList = async (
    slot: ActiveSlot,
  ): Promise<readonly AttachedCliCapabilitySummary[]> => {
    const started = clock.now();
    try {
      const child = await runVerb(
        slot,
        ["list"],
        ATTACHED_CLI_SESSION_LIMITS.listTimeoutMs,
      );
      if (child.exitCode !== 0) {
        const failure = attachedError("CONNECTION_FAILED");
        appendActivity(slot, "list", started, "error", {
          errorCode: failure.code,
          exitCode: child.exitCode,
        });
        throw failure;
      }
      const catalog = parseCatalog(child.stdout);
      appendActivity(slot, "list", started, "success", {
        exitCode: child.exitCode,
      });
      return catalog;
    } catch (cause) {
      const failure =
        cause instanceof AttachedCliSessionError
          ? cause
          : attachedError("CONNECTION_FAILED", cause);
      if (
        !slot.activity
          .entries()
          .some(
            (record) =>
              record.operation === "list" &&
              record.startedAt === startedAt(started),
          )
      ) {
        appendActivity(slot, "list", started, "error", {
          errorCode: failure.code,
        });
      }
      throw failure;
    }
  };

  const connect = async (
    owner: string,
    target: unknown,
  ): Promise<AttachedCliConnectionSummary> => {
    if (active !== undefined) throw attachedError("TARGET_BUSY");
    const parsed = parseTarget(target);
    lastValidationFailure = undefined;
    retainedActivity = undefined;
    const slot: ActiveSlot = {
      owner,
      target: parsed,
      activity: createActivityStore(),
      state: "connecting",
      catalog: Object.freeze([]),
      described: undefined,
      verbAbort: undefined,
      verbActive: false,
      verbPromise: undefined,
      connectionSummary: undefined,
    };
    active = slot;
    try {
      const catalog = await runList(slot);
      if (active !== slot) throw attachedError("NOT_CONNECTED");
      slot.catalog = catalog;
      slot.connectionSummary = connectionSummary(parsed, catalog);
      slot.state = "connected";
      return slot.connectionSummary;
    } catch (cause) {
      const failure =
        cause instanceof AttachedCliSessionError
          ? cause
          : attachedError("CONNECTION_FAILED", cause);
      failConnection(slot, failure);
      throw failure;
    }
  };

  const refresh = async (
    owner: string,
  ): Promise<AttachedCliConnectionSummary> => {
    const slot = requireOwner(owner, true);
    try {
      const catalog = await runList(slot);
      if (active !== slot) throw attachedError("NOT_CONNECTED");
      slot.catalog = catalog;
      slot.described = undefined;
      slot.connectionSummary = connectionSummary(slot.target, catalog);
      return slot.connectionSummary;
    } catch (cause) {
      const failure =
        cause instanceof AttachedCliSessionError
          ? cause
          : attachedError("CONNECTION_FAILED", cause);
      failConnection(slot, failure);
      throw failure;
    }
  };

  const describe = async (
    owner: string,
    id: string,
  ): Promise<AttachedCliCapabilityDescription> => {
    const slot = requireOwner(owner, true);
    if (typeof id !== "string" || id === "") {
      throw attachedError("INVALID_TARGET");
    }
    if (!slot.catalog.some((entry) => entry.id === id)) {
      throw attachedError("PROTOCOL_ERROR");
    }
    const started = clock.now();
    try {
      const child = await runVerb(
        slot,
        ["describe", id],
        ATTACHED_CLI_SESSION_LIMITS.describeTimeoutMs,
      );
      if (child.exitCode !== 0) {
        const failure = attachedError("CONNECTION_FAILED");
        appendActivity(slot, "describe", started, "error", {
          errorCode: failure.code,
          capabilityId: id,
          exitCode: child.exitCode,
        });
        slot.described = undefined;
        throw failure;
      }
      const described = parseDescription(child.stdout);
      appendActivity(slot, "describe", started, "success", {
        capabilityId: id,
        exitCode: child.exitCode,
      });
      slot.described = described;
      return described;
    } catch (cause) {
      const failure =
        cause instanceof AttachedCliSessionError
          ? cause
          : attachedError("CONNECTION_FAILED", cause);
      if (
        !slot.activity
          .entries()
          .some(
            (record) =>
              record.operation === "describe" &&
              record.startedAt === startedAt(started),
          )
      ) {
        appendActivity(slot, "describe", started, "error", {
          errorCode: failure.code,
          capabilityId: id,
        });
      }
      slot.described = undefined;
      throw failure;
    }
  };

  const run = async (
    owner: string,
    id: string,
    input: unknown,
  ): Promise<unknown> => {
    const slot = requireOwner(owner, true);
    if (slot.described === undefined || slot.described.id !== id) {
      throw attachedError("NOT_CONNECTED");
    }
    const encoded = encodeRunInput(input);
    const started = clock.now();
    try {
      const child = await runVerb(
        slot,
        ["run", id, "--input", encoded],
        ATTACHED_CLI_SESSION_LIMITS.runTimeoutMs,
      );
      if (child.exitCode !== 0) {
        const failure = attachedError("CONNECTION_FAILED");
        appendActivity(slot, "run", started, "error", {
          errorCode: failure.code,
          capabilityId: id,
          exitCode: child.exitCode,
        });
        throw failure;
      }
      const result = parseOneJson(child.stdout);
      appendActivity(slot, "run", started, "success", {
        capabilityId: id,
        exitCode: child.exitCode,
      });
      return result;
    } catch (cause) {
      const failure =
        cause instanceof AttachedCliSessionError
          ? cause
          : attachedError("CONNECTION_FAILED", cause);
      if (
        !slot.activity
          .entries()
          .some(
            (record) =>
              record.operation === "run" &&
              record.startedAt === startedAt(started),
          )
      ) {
        appendActivity(slot, "run", started, "error", {
          errorCode: failure.code,
          capabilityId: id,
        });
      }
      throw failure;
    }
  };

  const disconnect = async (owner: string): Promise<void> => {
    const slot = active;
    if (slot === undefined) return;
    if (slot.owner !== owner) throw attachedError("TARGET_BUSY");
    slot.state = "closing";
    slot.verbAbort?.abort(disconnectReason);
    const started = clock.now();
    try {
      await slot.verbPromise?.catch(() => undefined);
    } finally {
      appendActivity(slot, "disconnect", started, "success");
      clearSlot(slot);
      lastValidationFailure = undefined;
    }
  };

  return {
    connect,
    refresh,
    describe,
    run,
    state(owner) {
      if (active !== undefined) {
        if (active.owner !== owner) return { state: "busy" };
        if (active.state === "connecting") return { state: "connecting" };
        if (active.state === "closing") return { state: "closing" };
        if (active.connectionSummary !== undefined) {
          return {
            state: "connected",
            connection: active.connectionSummary,
          };
        }
      }
      const retained =
        retainedActivity?.owner === owner
          ? retainedActivity.records
          : undefined;
      if (lastValidationFailure?.owner === owner) {
        return {
          state: "idle",
          validation: {
            status: "error",
            error: {
              code: lastValidationFailure.code,
              message: lastValidationFailure.message,
            },
          },
          ...(retained === undefined ? {} : { activity: retained }),
        };
      }
      return {
        state: "idle",
        ...(retained === undefined ? {} : { activity: retained }),
      };
    },
    catalog(owner) {
      if (active === undefined || active.owner !== owner)
        return Object.freeze([]);
      return active.catalog;
    },
    description(owner) {
      if (active === undefined || active.owner !== owner) return undefined;
      return active.described;
    },
    activity(owner) {
      if (active !== undefined && active.owner === owner) {
        return active.activity.entries();
      }
      if (retainedActivity?.owner === owner) return retainedActivity.records;
      return Object.freeze([]);
    },
    disconnect,
    async close() {
      if (active === undefined) return;
      await disconnect(active.owner);
    },
  };
}
