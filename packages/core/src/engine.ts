import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import { EngineError } from "./error.js";
import {
  type InferSchemaInput,
  type InferSchemaOutput,
  readJsonSchema,
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
  if (inputSchema.type !== "object") {
    throw new TypeError(
      `Capability ${capabilityId} input schema must have an object root.`,
    );
  }
  if (outputSchema.type !== "object") {
    throw new TypeError(
      `Capability ${capabilityId} output schema must have an object root.`,
    );
  }
  return Object.freeze({
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
  return Object.freeze({
    id: description.id,
    description: description.description,
    ...(description.title === undefined ? {} : { title: description.title }),
    ...(description.annotations === undefined
      ? {}
      : { annotations: description.annotations }),
  });
}

function createSignal(
  received: AbortSignal | undefined,
  timeoutMs: number | undefined,
): { signal: AbortSignal; cleanup(): void } {
  if (timeoutMs === undefined) {
    return {
      signal: received ?? new AbortController().signal,
      cleanup: () => undefined,
    };
  }

  const controller = new AbortController();
  const abortFromReceived = (): void => controller.abort(received?.reason);
  if (received?.aborted === true) abortFromReceived();
  else received?.addEventListener("abort", abortFromReceived, { once: true });

  const timer = setTimeout(
    () => controller.abort(new Error("Capability invocation timed out.")),
    timeoutMs,
  );

  return {
    signal: controller.signal,
    cleanup() {
      received?.removeEventListener("abort", abortFromReceived);
      clearTimeout(timer);
    },
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
  if (signal.aborted) throw cancelled(signal.reason);
  let rejectOnAbort: ((reason: EngineError) => void) | undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = reject;
  });
  const onAbort = (): void => rejectOnAbort?.(cancelled(signal.reason));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([work, cancellation]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function normalizeError(error: unknown, signal?: AbortSignal): EngineError {
  if (error instanceof EngineError) return error;
  if (signal?.aborted === true) return cancelled(error ?? signal.reason);
  return new EngineError({
    code: "EXECUTION_FAILED",
    message: "Capability execution failed.",
    cause: error,
  });
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
      capabilities.set(capabilityId, capability);
      descriptions.set(
        capabilityId,
        describeCapability(capabilityId, capability),
      );
    }
  }
  const summaries = Object.freeze(
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
    list: () => summaries,
    describe(capabilityId) {
      const description = descriptions.get(capabilityId);
      if (description === undefined) {
        throw new EngineError({
          code: "CAPABILITY_NOT_FOUND",
          message: "Capability not found.",
          publicDetails: { capabilityId },
        });
      }
      return description;
    },
    async invoke(capabilityId, rawInput, options) {
      const requestId = options?.requestId ?? randomUUID();
      const source = options?.source ?? "direct";
      let principal: Principal | null = null;
      let principalError: EngineError | undefined;
      try {
        principal = snapshotPrincipal(options?.principal ?? null);
      } catch (cause) {
        principalError = cause as EngineError;
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
        const callerSignal = options?.signal ?? new AbortController().signal;
        const accessPrincipal = clonePrincipal(principal);
        const accessContext: ExecutionContext = Object.freeze({
          requestId,
          source,
          principal: accessPrincipal,
          signal: callerSignal,
          logger,
        });
        await enforceAccess(
          capabilityId,
          capability,
          structuredClone(input),
          accessContext,
        );

        signalState = createSignal(callerSignal, capability.timeoutMs);
        const context: ExecutionContext = Object.freeze({
          requestId,
          source,
          principal,
          signal: signalState.signal,
          logger,
        });
        if (context.signal.aborted) throw cancelled(context.signal.reason);

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
