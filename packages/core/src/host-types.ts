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
 * `instanceof Promise`. Node.js itself never downgrades: when the process
 * identifies as Node.js and `util.types` cannot be resolved, loading the core
 * fails instead.
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

/**
 * Whether a host global object identifies as Node.js itself. Deno, Bun, Edge
 * runtimes, and Web isolates may emulate `process.versions.node`, so they are
 * recognized by their own markers and by a `navigator.userAgent` that does not
 * name Node.js.
 */
export function identifiesAsNodeJs(host: object): boolean {
  try {
    const hostProcess = asObject(Reflect.get(host, "process"));
    const versions =
      hostProcess === undefined
        ? undefined
        : asObject(Reflect.get(hostProcess, "versions"));
    if (
      hostProcess === undefined ||
      versions === undefined ||
      typeof Reflect.get(versions, "node") !== "string" ||
      Reflect.get(versions, "deno") !== undefined ||
      Reflect.get(versions, "bun") !== undefined ||
      Reflect.get(host, "Deno") !== undefined ||
      Reflect.get(host, "Bun") !== undefined ||
      Reflect.get(host, "EdgeRuntime") !== undefined
    ) {
      return false;
    }
    const navigator = asObject(Reflect.get(host, "navigator"));
    const userAgent: unknown =
      navigator === undefined ? undefined : Reflect.get(navigator, "userAgent");
    if (typeof userAgent === "string" && !userAgent.startsWith("Node.js/")) {
      return false;
    }
    const release = asObject(Reflect.get(hostProcess, "release"));
    return release !== undefined && Reflect.get(release, "name") === "node";
  } catch {
    return false;
  }
}

/**
 * Resolves host introspection, or `undefined` for the portable fallback. A
 * Node.js process without it, such as a release before 22.3 or a sandbox that
 * replaced `process.getBuiltinModule`, fails closed.
 */
export function selectHostTypes(host: object): HostTypes | undefined {
  const types = resolveHostTypes(host);
  if (types === undefined && identifiesAsNodeJs(host)) {
    throw new Error(
      '@invokta/core requires util.types from process.getBuiltinModule("node:util") on Node.js 22.3 or later; it is unavailable or was replaced before the core loaded.',
    );
  }
  return types;
}

const hostTypes = selectHostTypes(globalThis);

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
