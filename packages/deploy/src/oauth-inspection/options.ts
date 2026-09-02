import { isCanonicalMcpPath } from "../mcp-path.js";

export interface OAuthInspectionOptions {
  readonly url: URL;
  readonly timeoutMs: number;
}

export type OAuthInspectionOptionsResult =
  | { readonly ok: true; readonly options: OAuthInspectionOptions }
  | { readonly ok: false };

export const oauthInspectionTimeoutDefaultMs = 10_000;
export const oauthInspectionTimeoutMinMs = 1;
export const oauthInspectionTimeoutMaxMs = 60_000;

const maxUrlLength = 2_048;
const loopbackHostnames: ReadonlySet<string> = new Set(["127.0.0.1", "[::1]"]);
const flagNames = ["--url", "--timeout-ms"] as const;
type FlagName = (typeof flagNames)[number];

const rejected: OAuthInspectionOptionsResult = { ok: false };

function isFlagName(value: string): value is FlagName {
  return (flagNames as readonly string[]).includes(value);
}

function rawPathOf(value: string): string {
  const schemeSeparator = value.indexOf("://");
  const authorityStart = schemeSeparator === -1 ? 0 : schemeSeparator + 3;
  const pathStart = value.indexOf("/", authorityStart);
  return pathStart === -1 ? "" : value.slice(pathStart);
}

function hasForbiddenUrlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
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

function parseTargetUrl(value: string): URL | undefined {
  if (
    value.length === 0 ||
    value.length > maxUrlLength ||
    hasForbiddenUrlCharacter(value)
  ) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username !== "" || url.password !== "") return undefined;
  if (url.search !== "" || url.hash !== "") return undefined;
  if (!isCanonicalMcpPath(url.pathname) || rawPathOf(value) !== url.pathname) {
    return undefined;
  }
  if (url.protocol === "http:" && !loopbackHostnames.has(url.hostname)) {
    return undefined;
  }
  return url;
}

function parseTimeout(value: string | undefined): number | undefined {
  if (value === undefined) return oauthInspectionTimeoutDefaultMs;
  if (!/^\d{1,5}$/u.test(value)) return undefined;
  const timeoutMs = Number(value);
  if (
    timeoutMs < oauthInspectionTimeoutMinMs ||
    timeoutMs > oauthInspectionTimeoutMaxMs
  ) {
    return undefined;
  }
  return timeoutMs;
}

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

export function parseOAuthInspectionOptions(
  args: readonly string[],
): OAuthInspectionOptionsResult {
  const flags = collectFlags(args);
  if (flags === undefined) return rejected;
  const rawUrl = flags.get("--url");
  if (rawUrl === undefined) return rejected;
  const url = parseTargetUrl(rawUrl);
  const timeoutMs = parseTimeout(flags.get("--timeout-ms"));
  if (url === undefined || timeoutMs === undefined) return rejected;
  return { ok: true, options: { url, timeoutMs } };
}
