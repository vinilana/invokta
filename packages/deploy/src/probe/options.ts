import { environmentNamePattern } from "../manifest.js";
import { probeTimeoutDefaultMs } from "../probe-contract.js";

export { probeTimeoutDefaultMs };

export type ProbeExpectation = "alive" | "ready";

export interface ProbeOptions {
  readonly url: URL;
  readonly expect: ProbeExpectation;
  /** The exact `Host` header the request carries. */
  readonly hostHeader: string;
  /** Present only for a readiness probe that names a bearer variable. */
  readonly bearerToken: string | undefined;
  readonly timeoutMs: number;
}

export type ProbeOptionsResult =
  | { readonly ok: true; readonly options: ProbeOptions }
  | { readonly ok: false };

export const probePath = "/mcp";
export const probeTimeoutMinMs = 1;
export const probeTimeoutMaxMs = 60_000;

const maxUrlLength = 2_048;
const maxHostHeaderLength = 255;
const maxBearerTokenLength = 4_096;
const loopbackHostnames: ReadonlySet<string> = new Set(["127.0.0.1", "[::1]"]);
const flagNames = [
  "--url",
  "--expect",
  "--bearer-env",
  "--host-header",
  "--timeout-ms",
] as const;

type FlagName = (typeof flagNames)[number];

const rejected: ProbeOptionsResult = { ok: false };

function isFlagName(value: string): value is FlagName {
  return (flagNames as readonly string[]).includes(value);
}

/**
 * A header value the probe is willing to emit: visible ASCII only, so a value
 * can neither inject a header nor make Node reject the request late.
 */
function isVisibleAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) return false;
  }
  return true;
}

function hasForbiddenUrlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    // A query or a fragment is rejected as text so an empty one cannot survive
    // URL normalization, and control characters never reach the wire.
    if (
      code <= 0x20 ||
      code === 0x7f ||
      character === "?" ||
      character === "#"
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The raw path exactly as written. `URL` collapses dot segments, so the
 * normalized pathname alone would accept aliases of the canonical route that
 * the adapter itself rejects.
 */
function rawPathOf(value: string): string {
  const schemeSeparator = value.indexOf("://");
  const authorityStart = schemeSeparator === -1 ? 0 : schemeSeparator + 3;
  const pathStart = value.indexOf("/", authorityStart);
  return pathStart === -1 ? "" : value.slice(pathStart);
}

function parseProbeUrl(value: string): URL | undefined {
  if (value.length === 0 || value.length > maxUrlLength) return undefined;
  if (hasForbiddenUrlCharacter(value)) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username !== "" || url.password !== "") return undefined;
  if (url.search !== "" || url.hash !== "") return undefined;
  if (url.pathname !== probePath || rawPathOf(value) !== probePath) {
    return undefined;
  }
  // Plain HTTP is a loopback development affordance only; every other target
  // must be reached through the TLS-terminating edge.
  if (url.protocol === "http:" && !loopbackHostnames.has(url.hostname)) {
    return undefined;
  }
  return url;
}

function parseTimeout(value: string | undefined): number | undefined {
  if (value === undefined) return probeTimeoutDefaultMs;
  if (!/^\d{1,5}$/u.test(value)) return undefined;
  const timeoutMs = Number(value);
  if (timeoutMs < probeTimeoutMinMs || timeoutMs > probeTimeoutMaxMs) {
    return undefined;
  }
  return timeoutMs;
}

function parseExpectation(
  value: string | undefined,
): ProbeExpectation | undefined {
  if (value === undefined || value === "alive") return "alive";
  return value === "ready" ? "ready" : undefined;
}

/**
 * Reads every flag into a map, rejecting an unknown flag, a repeated flag, a
 * missing value, and any positional argument. Nothing about a rejected
 * argument is retained, so no diagnostic can echo one.
 */
function collectFlags(
  args: readonly string[],
): ReadonlyMap<FlagName, string> | undefined {
  const values = new Map<FlagName, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (flag === undefined || !isFlagName(flag) || values.has(flag)) {
      return undefined;
    }
    const value = args[index + 1];
    if (value === undefined) return undefined;
    values.set(flag, value);
  }
  return values;
}

/**
 * Validates one `probe` invocation. The bearer token is read from the
 * environment by name and never from `args`, and the returned options are the
 * only place its value exists.
 */
export function parseProbeOptions(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): ProbeOptionsResult {
  const flags = collectFlags(args);
  if (flags === undefined) return rejected;

  const rawUrl = flags.get("--url");
  if (rawUrl === undefined) return rejected;
  const url = parseProbeUrl(rawUrl);
  if (url === undefined) return rejected;

  const expect = parseExpectation(flags.get("--expect"));
  if (expect === undefined) return rejected;

  const timeoutMs = parseTimeout(flags.get("--timeout-ms"));
  if (timeoutMs === undefined) return rejected;

  const hostHeader = flags.get("--host-header") ?? url.host;
  if (
    hostHeader.length === 0 ||
    hostHeader.length > maxHostHeaderLength ||
    !isVisibleAscii(hostHeader)
  ) {
    return rejected;
  }

  const bearerEnv = flags.get("--bearer-env");
  let bearerToken: string | undefined;
  if (bearerEnv !== undefined) {
    // A credential is meaningful only for readiness: a liveness probe proves
    // the boundary is serving precisely without holding one.
    if (expect !== "ready") return rejected;
    if (!environmentNamePattern.test(bearerEnv)) return rejected;
    const value = env[bearerEnv];
    if (
      value === undefined ||
      value.length === 0 ||
      value.length > maxBearerTokenLength ||
      !isVisibleAscii(value)
    ) {
      return rejected;
    }
    bearerToken = value;
  }

  return {
    ok: true,
    options: { url, expect, hostHeader, bearerToken, timeoutMs },
  };
}
