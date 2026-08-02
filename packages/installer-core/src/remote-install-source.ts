import { InstallerError } from "./installer-error.js";
import type { CapabilityInstallDescriptor } from "./registry.js";

export interface CreateRemoteInstallDescriptorOptions {
  readonly serverName: string;
  readonly url: string;
  readonly bearerTokenEnvironment?: string;
  readonly headerEnvironment?: readonly string[];
}

const serverNamePattern = /^[a-z][a-z0-9_-]{0,63}$/u;
const environmentNamePattern = /^[A-Z_][A-Z0-9_]{0,127}$/u;
const httpFieldNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const reservedHeaderNames = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function invalid(cause?: unknown): never {
  throw new InstallerError("REMOTE_INVALID", cause);
}

function canonicalUrl(value: string): string {
  if (value.includes("\0")) return invalid();
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    return invalid(cause);
  }
  const schemeSeparator = value.indexOf("://");
  if (schemeSeparator <= 0) return invalid();
  const authorityTail = value.slice(schemeSeparator + 3);
  const authorityEnd = authorityTail.search(/[/?#]/u);
  const authority = authorityTail.slice(
    0,
    authorityEnd === -1 ? undefined : authorityEnd,
  );
  const rawTarget =
    authorityEnd === -1 ? "" : authorityTail.slice(authorityEnd);
  const queryOrFragment = rawTarget.search(/[?#]/u);
  const rawPath = rawTarget.slice(
    0,
    queryOrFragment === -1 ? undefined : queryOrFragment,
  );
  const rawHost = authority.startsWith("[")
    ? authority.slice(0, authority.indexOf("]") + 1)
    : authority.split(":", 1)[0];
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    authority === "" ||
    authority.includes("@") ||
    url.hostname === "" ||
    url.username !== "" ||
    url.password !== "" ||
    rawPath !== "/mcp" ||
    url.pathname !== "/mcp" ||
    value.includes("?") ||
    value.includes("#")
  ) {
    return invalid();
  }
  if (
    url.protocol === "http:" &&
    rawHost !== "127.0.0.1" &&
    rawHost !== "[::1]"
  ) {
    return invalid();
  }
  return url.href;
}

function headersFromEnvironment(
  values: readonly string[],
  hasBearerAuthentication: boolean,
): Readonly<Record<string, string>> {
  if (values.length > 64) return invalid();
  const headers = new Map<string, string>();
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator <= 0 || separator === value.length - 1) return invalid();
    const rawName = value.slice(0, separator);
    const environmentName = value.slice(separator + 1);
    const name = rawName.toLowerCase();
    if (
      !httpFieldNamePattern.test(rawName) ||
      !environmentNamePattern.test(environmentName) ||
      reservedHeaderNames.has(name) ||
      (hasBearerAuthentication && name === "authorization") ||
      headers.has(name)
    ) {
      return invalid();
    }
    headers.set(name, environmentName);
  }
  return Object.freeze(
    Object.fromEntries(
      [...headers.entries()].sort(([left], [right]) =>
        left < right ? -1 : left === right ? 0 : 1,
      ),
    ),
  );
}

export function createRemoteInstallDescriptor(
  options: CreateRemoteInstallDescriptorOptions,
): CapabilityInstallDescriptor {
  if (!serverNamePattern.test(options.serverName)) return invalid();
  if (
    options.bearerTokenEnvironment !== undefined &&
    !environmentNamePattern.test(options.bearerTokenEnvironment)
  ) {
    return invalid();
  }
  const url = canonicalUrl(options.url);
  const authentication =
    options.bearerTokenEnvironment === undefined
      ? Object.freeze({ type: "none" as const })
      : Object.freeze({
          type: "bearer-env" as const,
          variable: options.bearerTokenEnvironment,
        });
  const headersFromEnv = headersFromEnvironment(
    options.headerEnvironment ?? [],
    authentication.type === "bearer-env",
  );
  const transport = Object.freeze({
    type: "streamable-http" as const,
    url,
    authentication,
    headersFromEnv,
  });
  return Object.freeze({
    id: `remote-${options.serverName.replaceAll("_", "-")}`,
    version: "remote",
    title: options.serverName,
    description: `Remote ${options.serverName} MCP server.`,
    capabilityIds: Object.freeze([`remote.${options.serverName}`]),
    server: Object.freeze({ name: options.serverName, transport }),
  });
}
