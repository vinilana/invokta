import { timingSafeEqual } from "node:crypto";
import { types as nodeTypes } from "node:util";

import {
  beginMcpOAuthAuthorization,
  connectMcpClient,
  type McpClientConnection,
  type McpClientErrorCode,
  type McpClientServerInfo,
  type McpClientTarget,
  type McpClientTool,
  type McpClientToolPage,
  type McpClientToolResult,
  type McpJsonValue,
  type McpOAuthAuthorization,
  type McpOAuthAuthorizationOptions,
  type McpOAuthClientTarget,
} from "@invokta/mcp";

export const ATTACHED_SESSION_LIMITS = Object.freeze({
  initializationTimeoutMs: 15_000,
  catalogTimeoutMs: 15_000,
  callTimeoutMs: 60_000,
  catalogBytes: 10 * 1024 * 1024,
  catalogPages: 100,
  catalogTools: 2_000,
  activityRecords: 500,
  oauthAuthorizationTimeoutMs: 300_000,
});

export type AttachedSessionErrorCode =
  | McpClientErrorCode
  | "TARGET_BUSY"
  | "NOT_CONNECTED"
  | "ENVIRONMENT_VALUE_MISSING";

const errorMessages = {
  INVALID_TARGET: "The MCP target descriptor is invalid.",
  SPAWN_FAILED: "The MCP server process could not be started.",
  CONNECTION_FAILED: "The MCP connection failed.",
  AUTHENTICATION_FAILED: "The MCP target rejected the supplied credentials.",
  PROTOCOL_ERROR: "The MCP peer returned an invalid protocol response.",
  TIMEOUT: "The MCP operation timed out.",
  LIMIT_EXCEEDED: "The MCP operation exceeded a configured limit.",
  CANCELLED: "The MCP operation was cancelled.",
  TARGET_BUSY: "Another target or tool operation is already active.",
  NOT_CONNECTED: "No MCP target is connected.",
  ENVIRONMENT_VALUE_MISSING: "A required environment value is missing.",
} as const satisfies Record<AttachedSessionErrorCode, string>;

const attachedErrorCodes = new Set<AttachedSessionErrorCode>(
  Object.keys(errorMessages) as AttachedSessionErrorCode[],
);

/** A stack-free serialization boundary for attached workbench failures. */
export class AttachedSessionError extends Error {
  declare readonly code: AttachedSessionErrorCode;
  declare readonly message: string;

  constructor(code: AttachedSessionErrorCode, options?: ErrorOptions) {
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

export interface AttachedActivityRecord {
  readonly sequence: number;
  readonly operation: "initialize" | "tools/list" | "tools/call" | "disconnect";
  readonly startedAt: string;
  readonly durationMs: number;
  readonly outcome: "success" | "error";
  readonly errorCode?: AttachedSessionErrorCode;
  readonly toolName?: string;
}

export interface AttachedConnectionSummary {
  readonly transport: "stdio" | "http";
  readonly server: {
    readonly name: string;
    readonly version: string;
    readonly protocolVersion: string;
  };
  readonly validation: { readonly status: "ok" };
  readonly pageCount: number;
  readonly toolCount: number;
}

export type AttachedSessionState =
  | {
      readonly state: "idle";
      readonly validation?: {
        readonly status: "error";
        readonly error: {
          readonly code: AttachedSessionErrorCode;
          readonly message: string;
        };
      };
    }
  | { readonly state: "busy" }
  | {
      readonly state: "connecting";
      readonly transport: "stdio" | "http";
    }
  | {
      readonly state: "authorizing";
      readonly transport: "http";
    }
  | {
      readonly state: "connected";
      readonly connection: AttachedConnectionSummary;
    }
  | {
      readonly state: "closing";
      readonly transport: "stdio" | "http";
    };

export interface AttachedSessionClock {
  now(): number;
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

type ConnectClient = typeof connectMcpClient;
type BeginOAuthAuthorization = typeof beginMcpOAuthAuthorization;

export interface CreateAttachedSessionControllerOptions {
  readonly connectClient?: ConnectClient;
  readonly beginOAuthAuthorization?: BeginOAuthAuthorization;
  readonly clock?: AttachedSessionClock;
}

export interface AttachedSessionController {
  connect(owner: string, target: unknown): Promise<AttachedConnectionSummary>;
  beginOAuth(
    owner: string,
    target: McpOAuthClientTarget,
    options: Omit<McpOAuthAuthorizationOptions, "signal">,
  ): Promise<{ readonly authorizationUrl: string }>;
  completeOAuth(
    state: string,
    authorizationCode: string,
  ): Promise<AttachedConnectionSummary>;
  rejectOAuth(state: string): Promise<void>;
  state(owner: string): AttachedSessionState;
  tools(owner: string): readonly McpClientTool[];
  call(
    owner: string,
    name: string,
    argumentsValue: Readonly<Record<string, McpJsonValue>>,
  ): Promise<McpClientToolResult>;
  activity(owner: string): readonly AttachedActivityRecord[];
  disconnect(owner: string): Promise<void>;
  close(): Promise<void>;
}

interface ActivityStore {
  append(
    record: Omit<AttachedActivityRecord, "sequence">,
  ): AttachedActivityRecord;
  entries(): readonly AttachedActivityRecord[];
  clear(): void;
}

interface ActiveSlot {
  readonly owner: string;
  readonly transport: "stdio" | "http";
  readonly activity: ActivityStore;
  state: "connecting" | "authorizing" | "connected" | "closing";
  connection: McpClientConnection | undefined;
  oauthAuthorization: McpOAuthAuthorization | undefined;
  oauthState: string | undefined;
  oauthExpiry: unknown | undefined;
  connectionSummary: AttachedConnectionSummary | undefined;
  catalog: readonly McpClientTool[];
  toolNames: ReadonlySet<string>;
  operationAbort: AbortController | undefined;
  callAbort: AbortController | undefined;
  callActive: boolean;
  closeClientPromise?: Promise<void>;
  closingPromise?: Promise<void>;
}

interface LastValidationFailure {
  readonly owner: string;
  readonly code: AttachedSessionErrorCode;
  readonly message: string;
}

const deadlineReason = Object.freeze({ type: "attached-deadline" });
const disconnectReason = Object.freeze({ type: "attached-disconnect" });
const maxActivityToolNameCodePoints = 256;

const defaultClock: AttachedSessionClock = {
  now: () => Date.now(),
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function createActivityStore(): ActivityStore {
  const records: AttachedActivityRecord[] = [];
  let nextSequence = 0;
  return {
    append: (record) => {
      nextSequence += 1;
      const stored = Object.freeze({ sequence: nextSequence, ...record });
      records.push(stored);
      if (records.length > ATTACHED_SESSION_LIMITS.activityRecords) {
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

function attachedError(
  code: AttachedSessionErrorCode,
  cause?: unknown,
): AttachedSessionError {
  return new AttachedSessionError(
    code,
    cause === undefined ? undefined : { cause },
  );
}

/**
 * Reduces a transient operational error to the only fields retained while the
 * workbench is idle. In particular, the upstream cause is never retained.
 */
export function retainValidationFailure(
  owner: string,
  failure: AttachedSessionError,
): Readonly<LastValidationFailure> {
  return Object.freeze({
    owner,
    code: failure.code,
    message: failure.message,
  });
}

function ownDataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor)) return undefined;
  return descriptor.value;
}

function normalizeFailure(
  cause: unknown,
  fallback: AttachedSessionErrorCode,
  signal?: AbortSignal,
): AttachedSessionError {
  if (cause instanceof AttachedSessionError) return cause;
  if (signal?.aborted === true) {
    return attachedError(
      signal.reason === deadlineReason ? "TIMEOUT" : "CANCELLED",
      cause,
    );
  }
  if (
    typeof cause === "object" &&
    cause !== null &&
    !nodeTypes.isProxy(cause)
  ) {
    const code = ownDataProperty(cause, "code");
    if (typeof code === "string" && attachedErrorCodes.has(code as never)) {
      return attachedError(code as AttachedSessionErrorCode, cause);
    }
  }
  return attachedError(fallback, cause);
}

function duration(clock: AttachedSessionClock, started: number): number {
  return Math.max(0, clock.now() - started);
}

function startedAt(started: number): string {
  try {
    return new Date(started).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

function appendActivity(
  slot: ActiveSlot,
  clock: AttachedSessionClock,
  operation: AttachedActivityRecord["operation"],
  started: number,
  outcome: "success" | "error",
  options: {
    readonly errorCode?: AttachedSessionErrorCode;
    readonly toolName?: string;
  } = {},
): void {
  const errorCode = options.errorCode;
  const toolName = options.toolName;
  slot.activity.append({
    operation,
    startedAt: startedAt(started),
    durationMs: duration(clock, started),
    outcome,
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(toolName === undefined ? {} : { toolName }),
  });
}

function targetTransport(target: unknown): "stdio" | "http" {
  if (
    typeof target !== "object" ||
    target === null ||
    nodeTypes.isProxy(target) ||
    Array.isArray(target)
  ) {
    throw attachedError("INVALID_TARGET");
  }
  const transport = ownDataProperty(target, "transport");
  if (transport !== "stdio" && transport !== "http") {
    throw attachedError("INVALID_TARGET");
  }
  return transport;
}

function hasInheritedToJson(prototype: object | null): boolean {
  let current = prototype;
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, "toJSON");
    if (descriptor !== undefined) {
      return !("value" in descriptor) || typeof descriptor.value === "function";
    }
    current = Object.getPrototypeOf(current);
  }
  return false;
}

function cloneLosslessJson(
  value: unknown,
  ancestors: Set<object> = new Set(),
): McpJsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw attachedError("PROTOCOL_ERROR");
    }
    return value;
  }
  if (
    typeof value !== "object" ||
    nodeTypes.isProxy(value) ||
    ancestors.has(value)
  ) {
    throw attachedError("PROTOCOL_ERROR");
  }

  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (
    isArray
      ? prototype !== Array.prototype
      : prototype !== Object.prototype && prototype !== null
  ) {
    throw attachedError("PROTOCOL_ERROR");
  }
  if (
    Object.getOwnPropertySymbols(value).length > 0 ||
    hasInheritedToJson(prototype)
  ) {
    throw attachedError("PROTOCOL_ERROR");
  }

  const keys = Object.keys(value);
  const propertyNames = Object.getOwnPropertyNames(value);
  if (isArray) {
    if (
      keys.length !== value.length ||
      propertyNames.length !== keys.length + 1 ||
      !propertyNames.includes("length")
    ) {
      throw attachedError("PROTOCOL_ERROR");
    }
    for (let index = 0; index < keys.length; index += 1) {
      if (keys[index] !== String(index)) throw attachedError("PROTOCOL_ERROR");
    }
  } else if (propertyNames.length !== keys.length) {
    throw attachedError("PROTOCOL_ERROR");
  }

  ancestors.add(value);
  try {
    if (isArray) {
      const clone: McpJsonValue[] = [];
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !("value" in descriptor)) {
          throw attachedError("PROTOCOL_ERROR");
        }
        clone.push(cloneLosslessJson(descriptor.value, ancestors));
      }
      return Object.freeze(clone);
    }

    const clone: Record<string, McpJsonValue> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw attachedError("PROTOCOL_ERROR");
      }
      Object.defineProperty(clone, key, {
        configurable: true,
        enumerable: true,
        value: cloneLosslessJson(descriptor.value, ancestors),
        writable: true,
      });
    }
    return Object.freeze(clone);
  } finally {
    ancestors.delete(value);
  }
}

function isJsonRecord(
  value: McpJsonValue | undefined,
): value is Readonly<Record<string, McpJsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function snapshotServerInfo(value: unknown): McpClientServerInfo {
  const snapshot = cloneLosslessJson(value);
  if (
    !isJsonRecord(snapshot) ||
    typeof snapshot.name !== "string" ||
    typeof snapshot.version !== "string" ||
    typeof snapshot.protocolVersion !== "string" ||
    !isJsonRecord(snapshot.capabilities) ||
    (snapshot.instructions !== undefined &&
      typeof snapshot.instructions !== "string")
  ) {
    throw attachedError("PROTOCOL_ERROR");
  }
  return snapshot as unknown as McpClientServerInfo;
}

function snapshotToolPage(value: unknown): McpClientToolPage {
  const snapshot = cloneLosslessJson(value);
  if (
    !isJsonRecord(snapshot) ||
    !Array.isArray(snapshot.tools) ||
    (snapshot.nextCursor !== undefined &&
      typeof snapshot.nextCursor !== "string")
  ) {
    throw attachedError("PROTOCOL_ERROR");
  }
  for (const candidate of snapshot.tools) {
    if (
      !isJsonRecord(candidate) ||
      typeof candidate.name !== "string" ||
      candidate.name.length === 0 ||
      !isJsonRecord(candidate.inputSchema) ||
      (candidate.title !== undefined && typeof candidate.title !== "string") ||
      (candidate.description !== undefined &&
        typeof candidate.description !== "string") ||
      (candidate.outputSchema !== undefined &&
        !isJsonRecord(candidate.outputSchema)) ||
      (candidate.annotations !== undefined &&
        !isJsonRecord(candidate.annotations))
    ) {
      throw attachedError("PROTOCOL_ERROR");
    }
  }
  return snapshot as unknown as McpClientToolPage;
}

function snapshotArguments(
  value: unknown,
): Readonly<Record<string, McpJsonValue>> {
  const snapshot = cloneLosslessJson(value);
  if (!isJsonRecord(snapshot)) throw attachedError("PROTOCOL_ERROR");
  return snapshot;
}

function snapshotToolResult(value: unknown): McpClientToolResult {
  const snapshot = cloneLosslessJson(value);
  if (!isJsonRecord(snapshot) || !isJsonRecord(snapshot.response)) {
    throw attachedError("PROTOCOL_ERROR");
  }
  return snapshot as unknown as McpClientToolResult;
}

function boundedToolName(name: string): string {
  return Array.from(name).slice(0, maxActivityToolNameCodePoints).join("");
}

function runWithDeadline<Value>(
  clock: AttachedSessionClock,
  timeoutMs: number,
  controller: AbortController,
  operation: (signal: AbortSignal) => Promise<Value>,
  onLateValue?: (value: Value) => void,
): Promise<Value> {
  return new Promise<Value>((resolve, reject) => {
    let settled = false;
    let handle: unknown;

    const cleanup = (): void => {
      clock.cancel(handle);
      controller.signal.removeEventListener("abort", onAbort);
    };
    const fail = (error: AttachedSessionError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      fail(
        attachedError(
          controller.signal.reason === deadlineReason ? "TIMEOUT" : "CANCELLED",
        ),
      );
    };

    controller.signal.addEventListener("abort", onAbort, { once: true });
    handle = clock.schedule(() => {
      if (settled) return;
      const timeout = attachedError("TIMEOUT");
      settled = true;
      cleanup();
      controller.abort(deadlineReason);
      reject(timeout);
    }, timeoutMs);

    let pending: Promise<Value>;
    try {
      pending = operation(controller.signal);
    } catch (cause) {
      fail(normalizeFailure(cause, "CONNECTION_FAILED", controller.signal));
      return;
    }
    void pending.then(
      (value) => {
        if (settled) {
          try {
            onLateValue?.(value);
          } catch {
            // Late cleanup is best-effort after the bounded operation settled.
          }
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      },
      (cause: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(cause);
      },
    );
  });
}

function closeLateConnection(connection: McpClientConnection): void {
  void connection.close().catch(() => undefined);
}

function closeLateAuthorization(authorization: McpOAuthAuthorization): void {
  void authorization.close().catch(() => undefined);
}

function equalOAuthState(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

export function createAttachedSessionController(
  options: CreateAttachedSessionControllerOptions = {},
): AttachedSessionController {
  const connectClient = options.connectClient ?? connectMcpClient;
  const beginOAuthAuthorization =
    options.beginOAuthAuthorization ?? beginMcpOAuthAuthorization;
  const clock = options.clock ?? defaultClock;
  let active: ActiveSlot | undefined;
  let lastValidationFailure: LastValidationFailure | undefined;

  const closeClientOnce = (slot: ActiveSlot): Promise<void> => {
    slot.closeClientPromise ??= (async () => {
      const connection = slot.connection;
      const authorization = slot.oauthAuthorization;
      slot.connection = undefined;
      slot.oauthAuthorization = undefined;
      const results = await Promise.allSettled([
        connection?.close() ?? Promise.resolve(),
        authorization?.close() ?? Promise.resolve(),
      ]);
      const failure = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (failure !== undefined) throw failure.reason;
    })();
    return slot.closeClientPromise;
  };

  const clearSlot = (slot: ActiveSlot): void => {
    if (slot.oauthExpiry !== undefined) clock.cancel(slot.oauthExpiry);
    slot.catalog = Object.freeze([]);
    slot.toolNames = new Set();
    slot.connectionSummary = undefined;
    slot.activity.clear();
    slot.operationAbort = undefined;
    slot.callAbort = undefined;
    slot.callActive = false;
    slot.oauthState = undefined;
    slot.oauthExpiry = undefined;
    if (active === slot) active = undefined;
  };

  const beginClose = (slot: ActiveSlot): Promise<void> => {
    if (slot.closingPromise !== undefined) return slot.closingPromise;
    slot.state = "closing";
    slot.operationAbort?.abort(disconnectReason);
    slot.callAbort?.abort(disconnectReason);
    const started = clock.now();
    slot.closingPromise = (async () => {
      let failure: AttachedSessionError | undefined;
      try {
        await closeClientOnce(slot);
        appendActivity(slot, clock, "disconnect", started, "success");
      } catch (cause) {
        failure = normalizeFailure(cause, "CONNECTION_FAILED");
        appendActivity(slot, clock, "disconnect", started, "error", {
          errorCode: failure.code,
        });
      } finally {
        clearSlot(slot);
        lastValidationFailure = undefined;
      }
      if (failure !== undefined) throw failure;
    })();
    return slot.closingPromise;
  };

  const collectCatalog = async (
    slot: ActiveSlot,
    signal: AbortSignal,
  ): Promise<{
    readonly tools: readonly McpClientTool[];
    readonly pageCount: number;
  }> => {
    const connection = slot.connection;
    if (connection === undefined) throw attachedError("NOT_CONNECTED");

    const tools: McpClientTool[] = [];
    const names = new Set<string>();
    const cursors = new Set<string>();
    let pageCount = 0;
    let cursor: string | undefined;
    let catalogBytes = 2;

    while (true) {
      if (pageCount >= ATTACHED_SESSION_LIMITS.catalogPages) {
        throw attachedError("LIMIT_EXCEEDED");
      }
      const listStarted = clock.now();
      let page: McpClientToolPage;
      try {
        page = snapshotToolPage(await connection.listTools(cursor, { signal }));
        appendActivity(slot, clock, "tools/list", listStarted, "success");
      } catch (cause) {
        const failure = normalizeFailure(cause, "PROTOCOL_ERROR", signal);
        appendActivity(slot, clock, "tools/list", listStarted, "error", {
          errorCode: failure.code,
        });
        throw failure;
      }
      pageCount += 1;

      if (
        tools.length + page.tools.length >
        ATTACHED_SESSION_LIMITS.catalogTools
      ) {
        throw attachedError("LIMIT_EXCEEDED");
      }
      for (const candidate of page.tools) {
        if (names.has(candidate.name)) throw attachedError("PROTOCOL_ERROR");
        const encoded = JSON.stringify(candidate);
        const candidateBytes = Buffer.byteLength(encoded);
        const separatorBytes = tools.length === 0 ? 0 : 1;
        if (
          catalogBytes + separatorBytes + candidateBytes >
          ATTACHED_SESSION_LIMITS.catalogBytes
        ) {
          throw attachedError("LIMIT_EXCEEDED");
        }
        catalogBytes += separatorBytes + candidateBytes;
        names.add(candidate.name);
        tools.push(candidate);
      }

      if (page.nextCursor === undefined) break;
      if (cursors.has(page.nextCursor)) {
        throw attachedError("PROTOCOL_ERROR");
      }
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }

    slot.toolNames = names;
    return { tools: Object.freeze(tools), pageCount };
  };

  const failConnection = async (
    slot: ActiveSlot,
    failure: AttachedSessionError,
  ): Promise<void> => {
    try {
      await closeClientOnce(slot);
    } catch {
      // The original bounded validation failure remains the public result.
    }
    if (active === slot && slot.state !== "closing") {
      clearSlot(slot);
      lastValidationFailure = retainValidationFailure(slot.owner, failure);
    }
  };

  const beginOAuth = async (
    owner: string,
    target: McpOAuthClientTarget,
    oauthOptions: Omit<McpOAuthAuthorizationOptions, "signal">,
  ): Promise<{ readonly authorizationUrl: string }> => {
    if (active !== undefined) throw attachedError("TARGET_BUSY");
    if (targetTransport(target) !== "http") {
      throw attachedError("INVALID_TARGET");
    }
    lastValidationFailure = undefined;
    const slot: ActiveSlot = {
      owner,
      transport: "http",
      activity: createActivityStore(),
      state: "connecting",
      connection: undefined,
      oauthAuthorization: undefined,
      oauthState: undefined,
      oauthExpiry: undefined,
      connectionSummary: undefined,
      catalog: Object.freeze([]),
      toolNames: new Set(),
      operationAbort: undefined,
      callAbort: undefined,
      callActive: false,
    };
    active = slot;
    const controller = new AbortController();
    slot.operationAbort = controller;
    try {
      const authorization = await runWithDeadline(
        clock,
        ATTACHED_SESSION_LIMITS.initializationTimeoutMs,
        controller,
        (signal) =>
          beginOAuthAuthorization(target, { ...oauthOptions, signal }),
        closeLateAuthorization,
      );
      if (active !== slot || slot.state !== "connecting") {
        closeLateAuthorization(authorization);
        throw attachedError("CANCELLED");
      }
      slot.oauthAuthorization = authorization;
      slot.oauthState = oauthOptions.state;
      slot.operationAbort = undefined;
      slot.state = "authorizing";
      slot.oauthExpiry = clock.schedule(() => {
        if (active !== slot || slot.state !== "authorizing") return;
        const failure = attachedError("TIMEOUT");
        slot.state = "closing";
        slot.oauthState = undefined;
        void closeClientOnce(slot)
          .catch(() => undefined)
          .finally(() => {
            clearSlot(slot);
            lastValidationFailure = retainValidationFailure(owner, failure);
          });
      }, ATTACHED_SESSION_LIMITS.oauthAuthorizationTimeoutMs);
      return Object.freeze({
        authorizationUrl: authorization.authorizationUrl,
      });
    } catch (cause) {
      const failure = normalizeFailure(
        cause,
        "AUTHENTICATION_FAILED",
        controller.signal,
      );
      await failConnection(slot, failure);
      throw failure;
    }
  };

  const completeOAuth = async (
    state: string,
    authorizationCode: string,
  ): Promise<AttachedConnectionSummary> => {
    const slot = active;
    if (slot === undefined || slot.state !== "authorizing") {
      throw attachedError("NOT_CONNECTED");
    }
    if (
      typeof state !== "string" ||
      slot.oauthState === undefined ||
      !equalOAuthState(state, slot.oauthState)
    ) {
      throw attachedError("AUTHENTICATION_FAILED");
    }
    const authorization = slot.oauthAuthorization;
    if (authorization === undefined) throw attachedError("NOT_CONNECTED");
    slot.oauthState = undefined;
    if (slot.oauthExpiry !== undefined) clock.cancel(slot.oauthExpiry);
    slot.oauthExpiry = undefined;
    const initializeStarted = clock.now();
    const initializeAbort = new AbortController();
    slot.operationAbort = initializeAbort;
    let initializeRecorded = false;
    try {
      const connection = await runWithDeadline(
        clock,
        ATTACHED_SESSION_LIMITS.initializationTimeoutMs,
        initializeAbort,
        (signal) => authorization.finish(authorizationCode, { signal }),
        closeLateConnection,
      );
      if (active !== slot || slot.state !== "authorizing") {
        closeLateConnection(connection);
        throw attachedError("CANCELLED");
      }
      slot.connection = connection;
      const serverInfo = snapshotServerInfo(connection.server);
      appendActivity(slot, clock, "initialize", initializeStarted, "success");
      initializeRecorded = true;

      const catalogAbort = new AbortController();
      slot.operationAbort = catalogAbort;
      const catalog = await runWithDeadline(
        clock,
        ATTACHED_SESSION_LIMITS.catalogTimeoutMs,
        catalogAbort,
        (signal) => collectCatalog(slot, signal),
      );
      if (active !== slot || slot.state !== "authorizing") {
        throw attachedError("CANCELLED");
      }

      slot.operationAbort = undefined;
      slot.catalog = catalog.tools;
      const summary: AttachedConnectionSummary = Object.freeze({
        transport: "http" as const,
        server: Object.freeze({
          name: serverInfo.name,
          version: serverInfo.version,
          protocolVersion: serverInfo.protocolVersion,
        }),
        validation: Object.freeze({ status: "ok" as const }),
        pageCount: catalog.pageCount,
        toolCount: catalog.tools.length,
      });
      slot.connectionSummary = summary;
      slot.state = "connected";
      return summary;
    } catch (cause) {
      const failure = normalizeFailure(
        cause,
        slot.connection === undefined
          ? "AUTHENTICATION_FAILED"
          : "PROTOCOL_ERROR",
        slot.operationAbort?.signal,
      );
      if (!initializeRecorded) {
        appendActivity(slot, clock, "initialize", initializeStarted, "error", {
          errorCode: failure.code,
        });
      }
      await failConnection(slot, failure);
      throw failure;
    }
  };

  const rejectOAuth = async (state: string): Promise<void> => {
    const slot = active;
    if (slot === undefined || slot.state !== "authorizing") {
      throw attachedError("NOT_CONNECTED");
    }
    if (
      typeof state !== "string" ||
      slot.oauthState === undefined ||
      !equalOAuthState(state, slot.oauthState)
    ) {
      throw attachedError("AUTHENTICATION_FAILED");
    }

    const failure = attachedError("AUTHENTICATION_FAILED");
    slot.oauthState = undefined;
    if (slot.oauthExpiry !== undefined) clock.cancel(slot.oauthExpiry);
    slot.oauthExpiry = undefined;
    slot.state = "closing";
    try {
      await closeClientOnce(slot);
    } catch {
      // The provider rejection remains the public result.
    }
    clearSlot(slot);
    lastValidationFailure = retainValidationFailure(slot.owner, failure);
  };

  const connect = async (
    owner: string,
    target: unknown,
  ): Promise<AttachedConnectionSummary> => {
    if (active !== undefined) throw attachedError("TARGET_BUSY");
    const transport = targetTransport(target);
    lastValidationFailure = undefined;
    const slot: ActiveSlot = {
      owner,
      transport,
      activity: createActivityStore(),
      state: "connecting",
      connection: undefined,
      oauthAuthorization: undefined,
      oauthState: undefined,
      oauthExpiry: undefined,
      connectionSummary: undefined,
      catalog: Object.freeze([]),
      toolNames: new Set(),
      operationAbort: undefined,
      callAbort: undefined,
      callActive: false,
    };
    active = slot;

    const initializeStarted = clock.now();
    const initializeAbort = new AbortController();
    slot.operationAbort = initializeAbort;
    let initializeRecorded = false;
    let connection: McpClientConnection;
    try {
      connection = await runWithDeadline(
        clock,
        ATTACHED_SESSION_LIMITS.initializationTimeoutMs,
        initializeAbort,
        (signal) =>
          connectClient(target as McpClientTarget, {
            signal,
          }),
        closeLateConnection,
      );
      if (active !== slot || slot.state !== "connecting") {
        closeLateConnection(connection);
        throw attachedError("CANCELLED");
      }
      slot.connection = connection;
      const serverInfo = snapshotServerInfo(connection.server);
      appendActivity(slot, clock, "initialize", initializeStarted, "success");
      initializeRecorded = true;

      const catalogAbort = new AbortController();
      slot.operationAbort = catalogAbort;
      const catalog = await runWithDeadline(
        clock,
        ATTACHED_SESSION_LIMITS.catalogTimeoutMs,
        catalogAbort,
        (signal) => collectCatalog(slot, signal),
      );
      if (active !== slot || slot.state !== "connecting") {
        throw attachedError("CANCELLED");
      }

      slot.operationAbort = undefined;
      slot.catalog = catalog.tools;
      const summary: AttachedConnectionSummary = Object.freeze({
        transport,
        server: Object.freeze({
          name: serverInfo.name,
          version: serverInfo.version,
          protocolVersion: serverInfo.protocolVersion,
        }),
        validation: Object.freeze({ status: "ok" as const }),
        pageCount: catalog.pageCount,
        toolCount: catalog.tools.length,
      });
      slot.connectionSummary = summary;
      slot.state = "connected";
      return summary;
    } catch (cause) {
      const failure = normalizeFailure(
        cause,
        slot.connection === undefined ? "CONNECTION_FAILED" : "PROTOCOL_ERROR",
        slot.operationAbort?.signal,
      );
      if (!initializeRecorded) {
        appendActivity(slot, clock, "initialize", initializeStarted, "error", {
          errorCode: failure.code,
        });
      }
      await failConnection(slot, failure);
      throw failure;
    }
  };

  const ownedConnectedSlot = (owner: string): ActiveSlot => {
    const slot = active;
    if (slot === undefined) throw attachedError("NOT_CONNECTED");
    if (slot.owner !== owner) throw attachedError("TARGET_BUSY");
    if (slot.state !== "connected") throw attachedError("NOT_CONNECTED");
    return slot;
  };

  const call = async (
    owner: string,
    name: string,
    argumentsValue: Readonly<Record<string, McpJsonValue>>,
  ): Promise<McpClientToolResult> => {
    const slot = ownedConnectedSlot(owner);
    if (slot.callActive) throw attachedError("TARGET_BUSY");
    if (typeof name !== "string" || !slot.toolNames.has(name)) {
      throw attachedError("PROTOCOL_ERROR");
    }
    const argumentsSnapshot = snapshotArguments(argumentsValue);
    const connection = slot.connection;
    if (connection === undefined) throw attachedError("NOT_CONNECTED");

    slot.callActive = true;
    const controller = new AbortController();
    slot.callAbort = controller;
    const callStarted = clock.now();
    const activityToolName = boundedToolName(name);
    try {
      const result = await runWithDeadline(
        clock,
        ATTACHED_SESSION_LIMITS.callTimeoutMs,
        controller,
        (signal) =>
          connection.callTool(name, argumentsSnapshot, {
            signal,
          }),
      );
      if (active !== slot || slot.state !== "connected") {
        throw attachedError("CANCELLED");
      }
      const snapshot = snapshotToolResult(result);
      appendActivity(slot, clock, "tools/call", callStarted, "success", {
        toolName: activityToolName,
      });
      return snapshot;
    } catch (cause) {
      const failure = normalizeFailure(
        cause,
        "CONNECTION_FAILED",
        controller.signal,
      );
      appendActivity(slot, clock, "tools/call", callStarted, "error", {
        errorCode: failure.code,
        toolName: activityToolName,
      });
      if (active === slot && slot.state === "connected") {
        slot.state = "closing";
        try {
          await closeClientOnce(slot);
        } catch {
          // The call failure remains the public result.
        }
        clearSlot(slot);
      }
      throw failure;
    } finally {
      slot.callActive = false;
      slot.callAbort = undefined;
    }
  };

  return {
    connect,
    beginOAuth,
    completeOAuth,
    rejectOAuth,
    state: (owner) => {
      const slot = active;
      if (slot === undefined) {
        const validation =
          lastValidationFailure?.owner === owner
            ? Object.freeze({
                status: "error" as const,
                error: Object.freeze({
                  code: lastValidationFailure.code,
                  message: lastValidationFailure.message,
                }),
              })
            : undefined;
        return Object.freeze({
          state: "idle" as const,
          ...(validation === undefined ? {} : { validation }),
        });
      }
      if (slot.owner !== owner)
        return Object.freeze({ state: "busy" as const });
      if (slot.state === "connecting") {
        return Object.freeze({
          state: "connecting" as const,
          transport: slot.transport,
        });
      }
      if (slot.state === "authorizing") {
        return Object.freeze({
          state: "authorizing" as const,
          transport: "http" as const,
        });
      }
      if (slot.state === "closing") {
        return Object.freeze({
          state: "closing" as const,
          transport: slot.transport,
        });
      }
      const connection = slot.connectionSummary;
      if (connection === undefined)
        return Object.freeze({
          state: "closing" as const,
          transport: slot.transport,
        });
      return Object.freeze({ state: "connected" as const, connection });
    },
    tools: (owner) => Object.freeze([...ownedConnectedSlot(owner).catalog]),
    call,
    activity: (owner) => {
      const slot = active;
      if (slot === undefined) {
        if (lastValidationFailure?.owner === owner) return Object.freeze([]);
        return Object.freeze([]);
      }
      if (slot.owner !== owner) throw attachedError("TARGET_BUSY");
      return slot.activity.entries();
    },
    disconnect: async (owner) => {
      const slot = active;
      if (slot === undefined) throw attachedError("NOT_CONNECTED");
      if (slot.owner !== owner) throw attachedError("TARGET_BUSY");
      await beginClose(slot);
    },
    close: async () => {
      const slot = active;
      if (slot === undefined) {
        lastValidationFailure = undefined;
        return;
      }
      await beginClose(slot);
    },
  };
}
