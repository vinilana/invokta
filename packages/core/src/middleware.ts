import { types as nodeUtilTypes } from "node:util";

import {
  isComposedCapabilities,
  markComposedCapabilities,
} from "./composition.js";
import { snapshotLosslessJson } from "./schema.js";
import type {
  AnyCapability,
  CapabilityMap,
  ExecutionContext,
} from "./types.js";

/**
 * What one middleware layer receives for one invocation.
 */
export interface CapabilityMiddlewareArgs {
  /** The capability's key in the map passed to `applyMiddleware`. */
  readonly capabilityId: string;
  /** A deep-frozen snapshot of the validated and transformed input. */
  readonly input: unknown;
  /** The engine's execution context, passed through unchanged. */
  readonly context: ExecutionContext;
  /**
   * Runs the rest of the chain and then the capability's `run`, resolving to
   * that layer's unvalidated result. It may be called at most once, only while
   * this middleware is still pending, and never starts the next layer after the
   * invocation signal has aborted.
   */
  readonly next: () => Promise<unknown>;
}

/**
 * Wraps a capability's execution. The engine validates whatever the outermost
 * middleware returns against the capability's output schema.
 */
export type CapabilityMiddleware = (
  args: CapabilityMiddlewareArgs,
) => Promise<unknown>;

type CapabilityRun = (args: {
  readonly input: unknown;
  readonly context: ExecutionContext;
}) => Promise<unknown>;

/**
 * Contract fields are also read from the prototype chain, matching how
 * `createEngine` reads a capability; every other own enumerable field is
 * carried over unchanged.
 */
const contractFields = [
  "title",
  "description",
  "input",
  "output",
  "access",
  "timeoutMs",
  "annotations",
] as const;

const abortSignalAbortedGetter = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  "aborted",
)?.get;
const abortSignalReasonGetter = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  "reason",
)?.get;

const ignoreRejection = (): void => undefined;

/**
 * Reads the signal through the platform accessors, as the engine does, so an
 * own-property override on a caller signal cannot run here.
 */
function abortReason(signal: AbortSignal): { readonly reason: unknown } | null {
  if (
    abortSignalAbortedGetter === undefined ||
    abortSignalReasonGetter === undefined
  ) {
    throw new TypeError("AbortSignal is not supported by this runtime.");
  }
  if (Reflect.apply(abortSignalAbortedGetter, signal, []) !== true) {
    return null;
  }
  return { reason: Reflect.apply(abortSignalReasonGetter, signal, []) };
}

function readCapabilityMap(value: unknown): object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("A capability map must be an object.");
  }
  if (nodeUtilTypes.isProxy(value)) {
    throw new TypeError("A capability map must not be a proxy.");
  }
  return value;
}

/**
 * Reads one property exactly once. A getter re-invoked later could return a
 * different value than the one this helper validated and wrapped.
 */
function readOnce(target: object, key: string, description: string): unknown {
  let current: object | null = target;
  while (current !== null) {
    if (nodeUtilTypes.isProxy(current)) {
      throw new TypeError(`${description} must not be a proxy.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor !== undefined) {
      if ("value" in descriptor) return descriptor.value;
      const getter = descriptor.get;
      return getter === undefined
        ? undefined
        : Reflect.apply(getter, target, []);
    }
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}

function defineField(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function createChain(
  capabilityId: string,
  run: CapabilityRun,
  middleware: readonly CapabilityMiddleware[],
): CapabilityRun {
  return async function runWithMiddleware(args) {
    const context = args.context;
    const input = snapshotLosslessJson(args.input);

    const dispatch = async (index: number): Promise<unknown> => {
      const layer = middleware[index];
      // The innermost call receives the engine's own arguments by identity.
      if (layer === undefined) return run(args);

      let nextCalled = false;
      let settled = false;
      const next = (): Promise<unknown> => {
        let pending: Promise<unknown>;
        if (settled) {
          pending = Promise.reject(
            new TypeError(
              "Capability middleware called next() after it settled.",
            ),
          );
        } else if (nextCalled) {
          pending = Promise.reject(
            new TypeError(
              "Capability middleware called next() more than once.",
            ),
          );
        } else {
          nextCalled = true;
          try {
            const aborted = abortReason(context.signal);
            pending =
              aborted === null
                ? dispatch(index + 1)
                : Promise.reject(aborted.reason);
          } catch (error) {
            pending = Promise.reject(error);
          }
        }
        // A forgotten next() promise must not become an unhandled rejection;
        // a middleware that awaits it still observes the failure.
        pending.catch(ignoreRejection);
        return pending;
      };

      try {
        return await layer(
          Object.freeze({ capabilityId, input, context, next }),
        );
      } finally {
        settled = true;
      }
    };

    return dispatch(0);
  };
}

function wrapCapability(
  capabilityId: string,
  capability: unknown,
  middleware: readonly CapabilityMiddleware[],
): AnyCapability {
  const description = `Capability ${capabilityId}`;
  if (typeof capability !== "object" || capability === null) {
    throw new TypeError(`${description} must be an object.`);
  }
  if (nodeUtilTypes.isProxy(capability)) {
    throw new TypeError(`${description} must not be a proxy.`);
  }

  const keys = new Set<string>([...Object.keys(capability), ...contractFields]);
  keys.add("run");
  const wrapped: Record<string, unknown> = {};
  let run: unknown;
  for (const key of keys) {
    const value = readOnce(capability, key, description);
    if (key === "run") {
      run = value;
      continue;
    }
    if (value !== undefined) defineField(wrapped, key, value);
  }
  if (typeof run !== "function") {
    throw new TypeError(`${description} run must be a function.`);
  }
  defineField(
    wrapped,
    "run",
    createChain(capabilityId, run as CapabilityRun, middleware),
  );
  return Object.freeze(wrapped) as unknown as AnyCapability;
}

/**
 * Returns a new frozen capability map whose `run` functions execute the given
 * middleware, first listed outermost, around the original handler. Every other
 * capability field is kept by identity, so the engine still validates input,
 * enforces `access`, applies cancellation and `timeoutMs`, validates output,
 * and normalizes errors exactly as for an unwrapped capability.
 *
 * This is a pure, eager function: it registers nothing, performs no I/O, and
 * invokes no middleware, access rule, or handler.
 */
export function applyMiddleware<const Capabilities extends CapabilityMap>(
  capabilities: Capabilities,
  ...middleware: readonly CapabilityMiddleware[]
): Capabilities {
  const layers: CapabilityMiddleware[] = [];
  for (let index = 0; index < middleware.length; index += 1) {
    const layer: unknown = middleware[index];
    if (typeof layer !== "function") {
      throw new TypeError("Every capability middleware must be a function.");
    }
    layers.push(layer as CapabilityMiddleware);
  }
  Object.freeze(layers);

  const source = readCapabilityMap(capabilities);
  const wrapped: Record<string, AnyCapability> = {};
  for (const capabilityId of Object.keys(source)) {
    const capability = readOnce(source, capabilityId, "A capability map");
    if (capability === undefined) continue;
    defineField(
      wrapped,
      capabilityId,
      layers.length === 0
        ? capability
        : wrapCapability(capabilityId, capability, layers),
    );
  }
  // The keys are unchanged one-to-one, so a composed map keeps its collision
  // guarantee; a plain map is never promoted to a tracked composition.
  if (isComposedCapabilities(source)) markComposedCapabilities(wrapped);
  return Object.freeze(wrapped) as unknown as Capabilities;
}
