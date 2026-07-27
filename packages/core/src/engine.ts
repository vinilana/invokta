import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { types as nodeUtilTypes } from "node:util";

import { EngineError, type EngineErrorCode } from "./error.js";
import {
  type InferSchemaInput,
  type InferSchemaOutput,
  readJsonSchema,
  snapshotLosslessJson,
  validateSchema,
} from "./schema.js";
import type {
  AnyCapability,
  CapabilityDescription,
  CapabilityMap,
  CapabilitySummary,
  EngineEvent,
  EngineLogger,
  ExecutionContext,
  InvokeOptions,
  Principal,
} from "./types.js";

type CapabilityInput<Capability extends AnyCapability> = InferSchemaInput<
  Capability["input"]
>;
type CapabilityOutput<Capability extends AnyCapability> = InferSchemaOutput<
  Capability["output"]
>;

export interface EngineDefinition<Capabilities extends CapabilityMap> {
  readonly name: string;
  readonly version: string;
  readonly capabilities: Capabilities;
  readonly logger?: EngineLogger;
  readonly onEvent?: (event: EngineEvent) => void | Promise<void>;
}

export interface Engine<Capabilities extends CapabilityMap = CapabilityMap> {
  readonly name: string;
  readonly version: string;
  invoke<CapabilityId extends Extract<keyof Capabilities, string>>(
    capabilityId: CapabilityId,
    input: CapabilityInput<Capabilities[CapabilityId]>,
    options?: InvokeOptions,
  ): Promise<CapabilityOutput<Capabilities[CapabilityId]>>;
  list(): ReadonlyArray<CapabilitySummary>;
  describe(
    capabilityId: Extract<keyof Capabilities, string>,
  ): CapabilityDescription;
}

const ignoreLog = (): void => undefined;
const noOpLogger: EngineLogger = Object.freeze({
  debug: ignoreLog,
  info: ignoreLog,
  warn: ignoreLog,
  error: ignoreLog,
});

const maximumTimeoutMs = 2_147_483_647;
const abortSignalAbortedGetter = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  "aborted",
)?.get;
const abortSignalReasonGetter = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  "reason",
)?.get;
const abortSignalAddEventListener = AbortSignal.prototype.addEventListener;
const abortSignalRemoveEventListener =
  AbortSignal.prototype.removeEventListener;
const engineErrorCodes = new Set<EngineErrorCode>([
  "CAPABILITY_NOT_FOUND",
  "INPUT_INVALID",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "OUTPUT_INVALID",
  "CANCELLED",
  "EXECUTION_FAILED",
]);

function readSignalAborted(signal: AbortSignal): boolean {
  if (abortSignalAbortedGetter === undefined) {
    throw new TypeError("AbortSignal is not supported by this runtime.");
  }
  return Reflect.apply(abortSignalAbortedGetter, signal, []) as boolean;
}

function readSignalReason(signal: AbortSignal): unknown {
  if (abortSignalReasonGetter === undefined) {
    throw new TypeError("AbortSignal is not supported by this runtime.");
  }
  return Reflect.apply(abortSignalReasonGetter, signal, []);
}

function addAbortListener(signal: AbortSignal, listener: () => void): void {
  Reflect.apply(abortSignalAddEventListener, signal, [
    "abort",
    listener,
    { once: true },
  ]);
}

function removeAbortListener(signal: AbortSignal, listener: () => void): void {
  Reflect.apply(abortSignalRemoveEventListener, signal, ["abort", listener]);
}

function isNativeAbortSignal(signal: AbortSignal): boolean {
  try {
    readSignalAborted(signal);
    return true;
  } catch {
    return false;
  }
}

function readReceivedAborted(signal: AbortSignal, native: boolean): boolean {
  return native ? readSignalAborted(signal) : signal.aborted;
}

function readReceivedReason(signal: AbortSignal, native: boolean): unknown {
  return native ? readSignalReason(signal) : signal.reason;
}

function addReceivedAbortListener(
  signal: AbortSignal,
  listener: () => void,
  native: boolean,
): void {
  if (native) addAbortListener(signal, listener);
  else signal.addEventListener("abort", listener, { once: true });
}

function removeReceivedAbortListener(
  signal: AbortSignal,
  listener: () => void,
  native: boolean,
): void {
  if (native) removeAbortListener(signal, listener);
  else signal.removeEventListener("abort", listener);
}

function validateTimeoutMs(
  capabilityId: string,
  timeoutMs: number | undefined,
): void {
  if (
    timeoutMs !== undefined &&
    (!Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > maximumTimeoutMs)
  ) {
    throw new TypeError(
      `Capability ${capabilityId} timeoutMs must be an integer from 1 through ${maximumTimeoutMs}.`,
    );
  }
}

function describeCapability(
  capabilityId: string,
  capability: AnyCapability,
): CapabilityDescription {
  let inputSchema: ReturnType<typeof readJsonSchema>;
  let outputSchema: ReturnType<typeof readJsonSchema>;
  try {
    inputSchema = readJsonSchema(capability.input, "input");
    outputSchema = readJsonSchema(capability.output, "output");
  } catch (cause) {
    throw new TypeError(
      `Capability ${capabilityId} could not produce its JSON Schemas.`,
      { cause },
    );
  }
  if (
    typeof inputSchema !== "object" ||
    inputSchema === null ||
    Array.isArray(inputSchema) ||
    inputSchema.type !== "object"
  ) {
    throw new TypeError(
      `Capability ${capabilityId} input schema must have an object root.`,
    );
  }
  if (
    typeof outputSchema !== "object" ||
    outputSchema === null ||
    Array.isArray(outputSchema) ||
    outputSchema.type !== "object"
  ) {
    throw new TypeError(
      `Capability ${capabilityId} output schema must have an object root.`,
    );
  }
  return snapshotLosslessJson({
    id: capabilityId,
    description: capability.description,
    ...(capability.title === undefined ? {} : { title: capability.title }),
    ...(capability.annotations === undefined
      ? {}
      : { annotations: capability.annotations }),
    ...(capability.timeoutMs === undefined
      ? {}
      : { timeoutMs: capability.timeoutMs }),
    inputSchema,
    outputSchema,
  });
}

function toSummary(description: CapabilityDescription): CapabilitySummary {
  return snapshotLosslessJson({
    id: description.id,
    description: description.description,
    ...(description.title === undefined ? {} : { title: description.title }),
    ...(description.annotations === undefined
      ? {}
      : { annotations: description.annotations }),
  });
}

function snapshotCapability(
  capabilityId: string,
  capability: AnyCapability,
): AnyCapability {
  const description = capability.description;
  const title = capability.title;
  const input = capability.input;
  const output = capability.output;
  const access = capability.access;
  const timeoutMs = capability.timeoutMs;
  const annotations = capability.annotations;
  const run = capability.run;

  validateTimeoutMs(capabilityId, timeoutMs);
  return Object.freeze({
    description,
    ...(title === undefined ? {} : { title }),
    input,
    output,
    access,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(annotations === undefined
      ? {}
      : { annotations: snapshotLosslessJson(annotations) }),
    run,
  }) as AnyCapability;
}

const callerSignalFailureCauses = new WeakMap<AbortSignal, unknown>();

function createSignal(
  received: AbortSignal | undefined,
  timeoutMs: number | undefined,
  forceWrapper = false,
): { signal: AbortSignal; cleanup(): void } {
  const nativeReceived =
    received === undefined || isNativeAbortSignal(received);
  if (timeoutMs === undefined && nativeReceived && !forceWrapper) {
    return {
      signal: received ?? new AbortController().signal,
      cleanup: () => undefined,
    };
  }

  const controller = new AbortController();
  let listening = false;
  let cleaned = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abortFromReceived = (): void => {
    if (received === undefined) return;
    try {
      controller.abort(readReceivedReason(received, nativeReceived));
    } catch (cause) {
      callerSignalFailureCauses.set(controller.signal, cause);
      controller.abort();
    }
  };

  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    if (listening && received !== undefined) {
      try {
        removeReceivedAbortListener(
          received,
          abortFromReceived,
          nativeReceived,
        );
      } catch {
        // Teardown cannot replace the invocation's result or original failure.
      }
    }
    if (timer !== undefined) clearTimeout(timer);
  };

  try {
    if (received !== undefined) {
      if (readReceivedAborted(received, nativeReceived)) abortFromReceived();
      else {
        listening = true;
        addReceivedAbortListener(received, abortFromReceived, nativeReceived);
      }
    }
    if (timeoutMs !== undefined) {
      timer = setTimeout(
        () => controller.abort(new Error("Capability invocation timed out.")),
        timeoutMs,
      );
    }
  } catch (cause) {
    cleanup();
    throw cause;
  }

  return {
    signal: controller.signal,
    cleanup,
  };
}

function cancelled(cause: unknown): EngineError {
  return new EngineError({
    code: "CANCELLED",
    message: "Capability invocation was cancelled.",
    cause,
  });
}

function unauthenticated(cause?: unknown): EngineError {
  return new EngineError({
    code: "UNAUTHENTICATED",
    message: "Authentication is required.",
    ...(cause === undefined ? {} : { cause }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function snapshotPrincipal(value: unknown): Principal | null {
  if (value === null) return null;
  try {
    const snapshot: unknown = structuredClone(value);
    if (!isRecord(snapshot)) throw new TypeError("Principal must be a record.");
    if (typeof snapshot.id !== "string" || snapshot.id.length === 0) {
      throw new TypeError("Principal id must be a non-empty string.");
    }
    if (snapshot.attributes !== undefined && !isRecord(snapshot.attributes)) {
      throw new TypeError("Principal attributes must be a record.");
    }
    return {
      id: snapshot.id,
      ...(snapshot.attributes === undefined
        ? {}
        : { attributes: snapshot.attributes }),
    };
  } catch (cause) {
    throw unauthenticated(cause);
  }
}

function clonePrincipal(snapshot: Principal | null): Principal | null {
  return snapshot === null ? null : structuredClone(snapshot);
}

async function raceWithCancellation<Value>(
  work: Promise<Value>,
  signal: AbortSignal,
): Promise<Value> {
  if (readSignalAborted(signal)) throw abortedSignalError(signal);
  let rejectOnAbort: ((reason: EngineError) => void) | undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = reject;
  });
  const onAbort = (): void => rejectOnAbort?.(abortedSignalError(signal));
  addAbortListener(signal, onAbort);
  try {
    return await Promise.race([work, cancellation]);
  } finally {
    try {
      removeAbortListener(signal, onAbort);
    } catch {
      // Cancellation teardown cannot replace the settled work outcome.
    }
  }
}

function isStableEngineError(error: unknown): error is EngineError {
  try {
    if (nodeUtilTypes.isProxy(error) || !(error instanceof EngineError)) {
      return false;
    }
    const code = Object.getOwnPropertyDescriptor(error, "code");
    const message = Object.getOwnPropertyDescriptor(error, "message");
    return (
      code !== undefined &&
      "value" in code &&
      engineErrorCodes.has(code.value as EngineErrorCode) &&
      message !== undefined &&
      "value" in message &&
      typeof message.value === "string"
    );
  } catch {
    return false;
  }
}

function executionFailed(cause: unknown): EngineError {
  return new EngineError({
    code: "EXECUTION_FAILED",
    message: "Capability execution failed.",
    cause,
  });
}

function abortedSignalError(signal: AbortSignal): EngineError {
  return callerSignalFailureCauses.has(signal)
    ? executionFailed(callerSignalFailureCauses.get(signal))
    : cancelled(readSignalReason(signal));
}

function normalizeError(error: unknown, signal?: AbortSignal): EngineError {
  if (isStableEngineError(error)) return error;
  try {
    if (signal !== undefined && readSignalAborted(signal)) {
      return callerSignalFailureCauses.has(signal)
        ? executionFailed(callerSignalFailureCauses.get(signal))
        : cancelled(error ?? readSignalReason(signal));
    }
  } catch {
    // A malformed cancellation signal cannot escape the normalized boundary.
  }
  return executionFailed(error);
}

async function enforceAccess(
  capabilityId: string,
  capability: AnyCapability,
  input: unknown,
  context: ExecutionContext,
): Promise<void> {
  if (capability.access === "public") return;
  if (capability.access === "authenticated") {
    if (context.principal === null) {
      throw unauthenticated();
    }
    return;
  }
  const access = capability.access as (args: {
    principal: ExecutionContext["principal"];
    input: unknown;
    context: ExecutionContext;
    capabilityId: string;
  }) => boolean | Promise<boolean>;
  if (
    (await access({
      principal: context.principal,
      input,
      context,
      capabilityId,
    })) === true
  ) {
    return;
  }
  throw new EngineError({
    code: context.principal === null ? "UNAUTHENTICATED" : "FORBIDDEN",
    message:
      context.principal === null
        ? "Authentication is required."
        : "Capability access is forbidden.",
  });
}

export function createEngine<const Capabilities extends CapabilityMap>(
  definition: EngineDefinition<Capabilities>,
): Engine<Capabilities> {
  const logger = definition.logger ?? noOpLogger;
  const onEvent = definition.onEvent;
  const capabilities = new Map<string, AnyCapability>();
  const descriptions = new Map<string, CapabilityDescription>();
  for (const capabilityId of Object.keys(definition.capabilities)) {
    const capability = definition.capabilities[capabilityId];
    if (capability !== undefined) {
      const snapshot = snapshotCapability(capabilityId, capability);
      capabilities.set(capabilityId, snapshot);
      descriptions.set(
        capabilityId,
        describeCapability(capabilityId, snapshot),
      );
    }
  }
  const summaries = snapshotLosslessJson(
    Array.from(descriptions.values(), toSummary),
  ) as ReadonlyArray<CapabilitySummary>;

  const reportEventHookFailure = (event: EngineEvent): void => {
    try {
      const diagnosticResult: unknown = logger.error(
        "Engine event hook failed.",
        {
          eventType: event.type,
          requestId: event.requestId,
        },
      );
      void Promise.resolve(diagnosticResult).catch(() => undefined);
    } catch {
      // Observability hooks must not change invocation behavior.
    }
  };

  const emit = (event: EngineEvent): void => {
    if (onEvent === undefined) return;
    try {
      const delivery = onEvent(event);
      void Promise.resolve(delivery).catch(() => reportEventHookFailure(event));
    } catch {
      reportEventHookFailure(event);
    }
  };

  return {
    name: definition.name,
    version: definition.version,
    list: () => snapshotLosslessJson(summaries),
    describe(capabilityId) {
      const description = descriptions.get(capabilityId);
      if (description === undefined) {
        throw new EngineError({
          code: "CAPABILITY_NOT_FOUND",
          message: "Capability not found.",
          publicDetails: { capabilityId },
        });
      }
      return snapshotLosslessJson(description);
    },
    async invoke(capabilityId, rawInput, options) {
      let requestId: string = randomUUID();
      let source: ExecutionContext["source"] = "direct";
      let optionsError: EngineError | undefined;
      try {
        const configuredRequestId = options?.requestId;
        const configuredSource = options?.source;
        requestId = configuredRequestId ?? requestId;
        source = configuredSource ?? source;
      } catch (cause) {
        optionsError = executionFailed(cause);
      }
      let principal: Principal | null = null;
      let principalError: EngineError | undefined;
      if (optionsError === undefined) {
        try {
          principal = snapshotPrincipal(options?.principal ?? null);
        } catch (cause) {
          principalError = unauthenticated(cause);
        }
      }
      const started = performance.now();
      emit({
        type: "invocation.started",
        requestId,
        capabilityId,
        source,
        ...(principal === null ? {} : { principalId: principal.id }),
        startedAt: new Date().toISOString(),
      });
      if (optionsError !== undefined) {
        emit({
          type: "invocation.failed",
          requestId,
          capabilityId,
          durationMs: performance.now() - started,
          code: optionsError.code,
        });
        throw optionsError;
      }

      let signalState: ReturnType<typeof createSignal> | undefined;
      try {
        const capability = capabilities.get(capabilityId);
        if (capability === undefined) {
          throw new EngineError({
            code: "CAPABILITY_NOT_FOUND",
            message: "Capability not found.",
            publicDetails: { capabilityId },
          });
        }
        const validatedInput = await validateSchema(
          capability.input,
          rawInput,
          {
            code: "INPUT_INVALID",
            message: "Capability input validation failed.",
          },
        );
        const input = structuredClone(validatedInput);
        if (principalError !== undefined) throw principalError;
        let callerSignal: AbortSignal;
        try {
          callerSignal = options?.signal ?? new AbortController().signal;
        } catch (cause) {
          throw executionFailed(cause);
        }
        const accessPrincipal = clonePrincipal(principal);
        let accessSignalState: ReturnType<typeof createSignal> | undefined;
        if (typeof capability.access === "function") {
          try {
            accessSignalState = createSignal(callerSignal, undefined, true);
          } catch (cause) {
            throw executionFailed(cause);
          }
        }
        if (
          accessSignalState !== undefined &&
          callerSignalFailureCauses.has(accessSignalState.signal)
        ) {
          accessSignalState.cleanup();
          throw executionFailed(
            callerSignalFailureCauses.get(accessSignalState.signal),
          );
        }
        const accessContext: ExecutionContext = Object.freeze({
          requestId,
          source,
          principal: accessPrincipal,
          signal: accessSignalState?.signal ?? callerSignal,
          logger,
        });
        let accessFailed = false;
        let accessFailure: unknown;
        try {
          await enforceAccess(
            capabilityId,
            capability,
            structuredClone(input),
            accessContext,
          );
        } catch (cause) {
          accessFailed = true;
          accessFailure = cause;
        } finally {
          accessSignalState?.cleanup();
        }
        if (
          accessSignalState !== undefined &&
          callerSignalFailureCauses.has(accessSignalState.signal)
        ) {
          throw executionFailed(
            callerSignalFailureCauses.get(accessSignalState.signal),
          );
        }
        if (accessFailed) throw accessFailure;

        try {
          signalState = createSignal(callerSignal, capability.timeoutMs);
        } catch (cause) {
          throw executionFailed(cause);
        }
        const context: ExecutionContext = Object.freeze({
          requestId,
          source,
          principal,
          signal: signalState.signal,
          logger,
        });
        if (readSignalAborted(context.signal)) {
          throw abortedSignalError(context.signal);
        }

        const run = capability.run as (args: {
          input: unknown;
          context: ExecutionContext;
        }) => Promise<unknown>;
        const rawOutput = await raceWithCancellation(
          Promise.resolve().then(() => run({ input, context })),
          context.signal,
        );
        const output = await raceWithCancellation(
          validateSchema(capability.output, rawOutput, {
            code: "OUTPUT_INVALID",
            message: "Capability output validation failed.",
          }),
          context.signal,
        );
        signalState.cleanup();
        signalState = undefined;
        emit({
          type: "invocation.completed",
          requestId,
          capabilityId,
          durationMs: performance.now() - started,
        });
        return output as CapabilityOutput<Capabilities[typeof capabilityId]>;
      } catch (cause) {
        const error = normalizeError(cause, signalState?.signal);
        signalState?.cleanup();
        signalState = undefined;
        emit({
          type: "invocation.failed",
          requestId,
          capabilityId,
          durationMs: performance.now() - started,
          code: error.code,
        });
        throw error;
      } finally {
        signalState?.cleanup();
      }
    },
  };
}
