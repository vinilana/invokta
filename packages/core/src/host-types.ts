/**
 * Object-type introspection supplied by the host runtime (ADR 0042).
 *
 * ECMAScript offers no way to recognize a proxy without running its traps, or
 * a native promise without reading user-controlled properties. Node.js 22.3
 * and later, Deno, and Bun expose `util.types` through
 * `process.getBuiltinModule`, which inspects the engine's internal object type
 * without executing user code. The core reads it once, when this module is
 * evaluated, so replacing the global afterwards cannot change the guards.
 *
 * A host without it, such as a Web-only isolate, gets a portable fallback:
 * proxy detection reports `false`, so the core relies on its remaining
 * structural checks, platform brand checks, and the structured-clone rejection
 * the HTML specification mandates for proxies; promise detection uses
 * `instanceof Promise`.
 */
export interface HostTypes {
  readonly isProxy: (value: unknown) => boolean;
  readonly isPromise: (value: unknown) => value is Promise<unknown>;
}

function asObject(value: unknown): object | undefined {
  return (typeof value === "object" || typeof value === "function") &&
    value !== null
    ? value
    : undefined;
}

/** Resolves `util.types` from a host global object, or `undefined`. */
export function resolveHostTypes(host: object): HostTypes | undefined {
  try {
    const hostProcess = asObject(Reflect.get(host, "process"));
    if (hostProcess === undefined) return undefined;
    const getBuiltinModule: unknown = Reflect.get(
      hostProcess,
      "getBuiltinModule",
    );
    if (typeof getBuiltinModule !== "function") return undefined;
    const util = asObject(
      Reflect.apply(getBuiltinModule, hostProcess, ["node:util"]),
    );
    const types =
      util === undefined ? undefined : asObject(Reflect.get(util, "types"));
    if (types === undefined) return undefined;
    const isProxy: unknown = Reflect.get(types, "isProxy");
    const isPromise: unknown = Reflect.get(types, "isPromise");
    if (typeof isProxy !== "function" || typeof isPromise !== "function") {
      return undefined;
    }
    return Object.freeze({
      isProxy: (value: unknown) =>
        Reflect.apply(isProxy, undefined, [value]) === true,
      isPromise: (value: unknown): value is Promise<unknown> =>
        Reflect.apply(isPromise, undefined, [value]) === true,
    });
  } catch {
    return undefined;
  }
}

const hostTypes = resolveHostTypes(globalThis);

/**
 * `host` when proxies and promises are recognized without running user code;
 * `portable` when the fallback described above is in effect.
 */
export const hostTypeIntrospection: "host" | "portable" =
  hostTypes === undefined ? "portable" : "host";

export const isProxy: (value: unknown) => boolean =
  hostTypes?.isProxy ?? (() => false);

export const isPromise: (value: unknown) => value is Promise<unknown> =
  hostTypes?.isPromise ??
  ((value): value is Promise<unknown> => value instanceof Promise);
