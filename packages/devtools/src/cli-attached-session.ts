import { spawn as defaultSpawn } from "node:child_process";

import {
  ATTACHED_CLI_SESSION_LIMITS,
  attachedCliError,
  type AttachedCliActivityRecord,
  type AttachedCliCapabilityDescription,
  type AttachedCliCapabilitySummary,
  type AttachedCliChildResult,
  type AttachedCliConnectionSummary,
  type AttachedCliSessionClock,
  type AttachedCliSessionController,
  AttachedCliSessionError,
  type AttachedCliSessionErrorCode,
  type AttachedCliSpawn,
  type CreateAttachedCliSessionControllerOptions,
  type ParsedCliTarget,
} from "./cli-attached-contract.js";
import {
  collectAttachedCliChild,
  runAttachedCliWithDeadline,
} from "./cli-attached-process.js";
import {
  encodeAttachedCliRunInput,
  parseAttachedCliCatalog,
  parseAttachedCliDescription,
  parseAttachedCliJson,
} from "./cli-attached-protocol.js";
import {
  composeAttachedCliEnvironment,
  parseAttachedCliTarget,
} from "./cli-attached-target.js";

export {
  ATTACHED_CLI_SESSION_LIMITS,
  type AttachedCliActivityRecord,
  type AttachedCliAnnotations,
  type AttachedCliCapabilityDescription,
  type AttachedCliCapabilitySummary,
  type AttachedCliConnectionSummary,
  type AttachedCliSessionClock,
  type AttachedCliSessionController,
  AttachedCliSessionError,
  type AttachedCliSessionErrorCode,
  type AttachedCliSessionState,
  type AttachedCliSpawn,
  type AttachedCliSpawnOptions,
  type CreateAttachedCliSessionControllerOptions,
} from "./cli-attached-contract.js";

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

const defaultKillGraceMs = 3_000;
const disconnectReason = Object.freeze({ type: "attached-cli-disconnect" });

const defaultClock: AttachedCliSessionClock = {
  now: () => Date.now(),
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

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
    if (active === undefined) throw attachedCliError("NOT_CONNECTED");
    if (active.owner !== owner) throw attachedCliError("TARGET_BUSY");
    if (active.verbActive) throw attachedCliError("TARGET_BUSY");
    if (connected && active.state !== "connected") {
      throw attachedCliError("NOT_CONNECTED");
    }
    return active;
  };

  const runVerb = async (
    slot: ActiveSlot,
    verbArgs: readonly string[],
    timeoutMs: number,
  ): Promise<AttachedCliChildResult> => {
    if (slot.verbActive) throw attachedCliError("TARGET_BUSY");
    slot.verbActive = true;
    const controller = new AbortController();
    slot.verbAbort = controller;
    const env = composeAttachedCliEnvironment(
      slot.target.overlay,
      platform,
      readHostEnv,
    );
    const pending = runAttachedCliWithDeadline(
      clock,
      timeoutMs,
      controller,
      (signal) =>
        collectAttachedCliChild(
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
        const failure = attachedCliError("CONNECTION_FAILED");
        appendActivity(slot, "list", started, "error", {
          errorCode: failure.code,
          exitCode: child.exitCode,
        });
        throw failure;
      }
      const catalog = parseAttachedCliCatalog(child.stdout);
      appendActivity(slot, "list", started, "success", {
        exitCode: child.exitCode,
      });
      return catalog;
    } catch (cause) {
      const failure =
        cause instanceof AttachedCliSessionError
          ? cause
          : attachedCliError("CONNECTION_FAILED", cause);
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
    if (active !== undefined) throw attachedCliError("TARGET_BUSY");
    const parsed = parseAttachedCliTarget(target);
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
      if (active !== slot) throw attachedCliError("NOT_CONNECTED");
      slot.catalog = catalog;
      slot.connectionSummary = connectionSummary(parsed, catalog);
      slot.state = "connected";
      return slot.connectionSummary;
    } catch (cause) {
      const failure =
        cause instanceof AttachedCliSessionError
          ? cause
          : attachedCliError("CONNECTION_FAILED", cause);
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
      if (active !== slot) throw attachedCliError("NOT_CONNECTED");
      slot.catalog = catalog;
      slot.described = undefined;
      slot.connectionSummary = connectionSummary(slot.target, catalog);
      return slot.connectionSummary;
    } catch (cause) {
      const failure =
        cause instanceof AttachedCliSessionError
          ? cause
          : attachedCliError("CONNECTION_FAILED", cause);
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
      throw attachedCliError("INVALID_TARGET");
    }
    if (!slot.catalog.some((entry) => entry.id === id)) {
      throw attachedCliError("PROTOCOL_ERROR");
    }
    const started = clock.now();
    try {
      const child = await runVerb(
        slot,
        ["describe", id],
        ATTACHED_CLI_SESSION_LIMITS.describeTimeoutMs,
      );
      if (child.exitCode !== 0) {
        const failure = attachedCliError("CONNECTION_FAILED");
        appendActivity(slot, "describe", started, "error", {
          errorCode: failure.code,
          capabilityId: id,
          exitCode: child.exitCode,
        });
        slot.described = undefined;
        throw failure;
      }
      const described = parseAttachedCliDescription(child.stdout);
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
          : attachedCliError("CONNECTION_FAILED", cause);
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
      throw attachedCliError("NOT_CONNECTED");
    }
    const encoded = encodeAttachedCliRunInput(input);
    const started = clock.now();
    try {
      const child = await runVerb(
        slot,
        ["run", id, "--input", encoded],
        ATTACHED_CLI_SESSION_LIMITS.runTimeoutMs,
      );
      if (child.exitCode !== 0) {
        const failure = attachedCliError("CONNECTION_FAILED");
        appendActivity(slot, "run", started, "error", {
          errorCode: failure.code,
          capabilityId: id,
          exitCode: child.exitCode,
        });
        throw failure;
      }
      const result = parseAttachedCliJson(child.stdout);
      appendActivity(slot, "run", started, "success", {
        capabilityId: id,
        exitCode: child.exitCode,
      });
      return result;
    } catch (cause) {
      const failure =
        cause instanceof AttachedCliSessionError
          ? cause
          : attachedCliError("CONNECTION_FAILED", cause);
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
    if (slot.owner !== owner) throw attachedCliError("TARGET_BUSY");
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
      if (active === undefined || active.owner !== owner) {
        return Object.freeze([]);
      }
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
