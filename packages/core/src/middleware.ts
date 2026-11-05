import {
  isComposedCapabilities,
  markComposedCapabilities,
} from "./composition.js";
import { isProxy } from "./host-types.js";
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
  /**
   * A deep-frozen snapshot of the validated and transformed input, taken on
   * first read and shared by every middleware of the invocation. `run` keeps
   * its own copy, so read the input before `next()` when the value as
   * validated matters.
   */
  readonly input: unknown;
  /**
   * The engine's execution context, passed through unchanged. Its principal is
   * the same object `run` receives and must not be mutated.
   */
  readonly context: ExecutionContext;
  /**
   * Runs the rest of the chain and then the capability's `run`, resolving to
   * that layer's unvalidated result. It may be called at most once, only while
   * this middleware is still pending, and never starts the next layer after the
   * invocation signal has aborted. A started layer always settles before the
   * middleware's own result is returned.
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
 * Input snapshots keyed by the engine's per-invocation `run` arguments. Nested
 * applications receive the same arguments object, so they share one snapshot.
 */
const inputSnapshots = new WeakMap<
  object,
  { readonly source: unknown; readonly snapshot: unknown }
>();

function freezeSnapshot(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return;
  }
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    freezeSnapshot((value as Record<string, unknown>)[key]);
  }
}

/**
 * The engine has already validated the input as lossless JSON, so a clone and
 * a freeze are enough. The work happens only when a middleware reads `input`.
 */
function readInputSnapshot(args: object, source: unknown): unknown {
  const cached = inputSnapshots.get(args);
  if (cached !== undefined && cached.source === source) return cached.snapshot;
  const snapshot: unknown = structuredClone(source);
  freezeSnapshot(snapshot);
  inputSnapshots.set(args, { source, snapshot });
  return snapshot;
}

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
  if (isProxy(value)) {
    throw new TypeError("A capability map must not be a proxy.");
  }
  return value;
}

/**
 * Reads one property exactly once, through the prototype chain like ordinary
 * property access. A getter re-invoked later could return a different value
 * than the one this helper validated and wrapped.
 */
function readProperty(
  target: object,
  key: PropertyKey,
  description: string,
): {
  readonly found: boolean;
  readonly value: unknown;
  readonly enumerable: boolean;
} {
  let current: object | null = target;
  while (current !== null) {
    if (isProxy(current)) {
      throw new TypeError(`${description} must not be a proxy.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor !== undefined) {
      const enumerable = descriptor.enumerable === true;
      if ("value" in descriptor) {
        return { found: true, value: descriptor.value, enumerable };
      }
      const getter = descriptor.get;
      return {
        found: true,
        value:
          getter === undefined ? undefined : Reflect.apply(getter, target, []),
        enumerable,
      };
    }
    current = Object.getPrototypeOf(current);
  }
  return { found: false, value: undefined, enumerable: false };
}

/**
 * The capability contract fields read through the prototype chain, as
 * `createEngine` and the contracts built on it read them. Other inherited
 * members, such as class methods, lazy getters, `constructor`, and symbols, are
 * neither invoked nor copied.
 */
const contractFields = [
  "title",
  "description",
  "input",
  "output",
  "access",
  "timeoutMs",
  "annotations",
  "errors",
  "deprecated",
  "run",
] as const;

/**
 * Every own key of the capability, of any kind, plus the contract fields,
 * which may also be inherited.
 */
function capabilityKeys(capability: object): readonly PropertyKey[] {
  return [
    ...new Set<PropertyKey>([
      ...Reflect.ownKeys(capability),
      ...contractFields,
    ]),
  ];
}

function defineField(
  target: object,
  key: PropertyKey,
  value: unknown,
  enumerable = true,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable,
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
    const source = args.input;

    const dispatch = async (index: number): Promise<unknown> => {
      const layer = middleware[index];
      // The innermost call receives the engine's own arguments by identity.
      if (layer === undefined) return run(args);

      let started: Promise<unknown> | undefined;
      let settled = false;
      const next = (): Promise<unknown> => {
        let pending: Promise<unknown>;
        if (settled) {
          pending = Promise.reject(
            new TypeError(
              "Capability middleware called next() after it settled.",
            ),
          );
        } else if (started !== undefined) {
          pending = Promise.reject(
            new TypeError(
              "Capability middleware called next() more than once.",
            ),
          );
        } else {
          // Claim the single call before dispatching, so that a re-entrant
          // call from the synchronous start of the next layer is refused.
          started = Promise.resolve();
          try {
            const aborted = abortReason(context.signal);
            pending =
              aborted === null
                ? dispatch(index + 1)
                : Promise.reject(aborted.reason);
          } catch (error) {
            pending = Promise.reject(error);
          }
          started = pending;
        }
        // A forgotten next() promise must not become an unhandled rejection;
        // a middleware that awaits it still observes the failure.
        pending.catch(ignoreRejection);
        return pending;
      };

      try {
        return await layer(
          Object.freeze({
            capabilityId,
            get input() {
              return readInputSnapshot(args, source);
            },
            context,
            next,
          }),
        );
      } finally {
        settled = true;
        // A layer the middleware started but did not await still belongs to
        // this invocation: it settles, within the same timeout and signal,
        // before this layer's result is returned. Its outcome is ignored.
        if (started !== undefined) {
          await started.then(ignoreRejection, ignoreRejection);
        }
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
  if (isProxy(capability)) {
    throw new TypeError(`${description} must not be a proxy.`);
  }

  const wrapped: Record<PropertyKey, unknown> = {};
  let run: unknown;
  let runEnumerable = true;
  for (const key of capabilityKeys(capability)) {
    const { found, value, enumerable } = readProperty(
      capability,
      key,
      description,
    );
    if (!found) continue;
    if (key === "run") {
      run = value;
      runEnumerable = enumerable;
      continue;
    }
    defineField(wrapped, key, value, enumerable);
  }
  if (typeof run !== "function") {
    throw new TypeError(`${description} run must be a function.`);
  }
  defineField(
    wrapped,
    "run",
    createChain(capabilityId, run as CapabilityRun, middleware),
    runEnumerable,
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
    const capability = readProperty(
      source,
      capabilityId,
      "A capability map",
    ).value;
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
