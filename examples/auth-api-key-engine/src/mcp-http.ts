import { pathToFileURL } from "node:url";

import type { Principal } from "@invokta/core";
import {
  type McpHttpAuthenticationRequest,
  type McpHttpHeaderView,
  type McpHttpServerHandle,
  serveMcpHttp,
} from "@invokta/mcp";

import { engine } from "./engine.js";
import { toPrincipal } from "./identity/principal.js";
import {
  type ApiKeyVerifier,
  createApiKeyRegistryFromEnvironment,
  createApiKeyVerifier,
} from "./identity/verifier.js";

const BEARER_PATTERN = /^Bearer ([^\s]+)$/u;

export interface ApiKeyMcpHttpOptions {
  readonly verifier: ApiKeyVerifier;
  readonly host?: string;
  readonly port?: number;
}

/** Reads the single credential the adapter guarantees is unambiguous. */
export function readBearerCredential(
  headers: McpHttpHeaderView,
): string | null {
  const authorization = headers.get("authorization");
  if (authorization === null) return null;
  return BEARER_PATTERN.exec(authorization)?.[1] ?? null;
}

/**
 * The authenticate hook: a principal for a valid key, null for every invalid
 * or missing credential, and a rejection only when the registry lookup itself
 * cannot complete.
 */
export function createApiKeyAuthenticate(
  verifier: ApiKeyVerifier,
): (request: McpHttpAuthenticationRequest) => Promise<Principal | null> {
  return async (request) => {
    const credential = readBearerCredential(request.headers);
    if (credential === null) return null;

    const verified = await verifier.verify(credential, {
      signal: request.signal,
    });
    return verified === null ? null : toPrincipal(verified);
  };
}

export async function startApiKeyMcpHttp(
  options: ApiKeyMcpHttpOptions,
): Promise<McpHttpServerHandle> {
  return serveMcpHttp(engine, {
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.port === undefined ? {} : { port: options.port }),
    auth: {
      mode: "required",
      authenticate: createApiKeyAuthenticate(options.verifier),
    },
  });
}

export async function main(): Promise<McpHttpServerHandle> {
  const verifier = createApiKeyVerifier({
    registry: createApiKeyRegistryFromEnvironment(process.env),
  });
  const configuredPort = process.env.PORT;
  const port = configuredPort === undefined ? 3000 : Number(configuredPort);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("PORT must be an integer between 0 and 65535.");
  }
  return startApiKeyMcpHttp({ verifier, port });
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  await main()
    .then((server) => {
      const address = server.address();
      process.stderr.write(
        `API key engine MCP HTTP adapter listening on host ${address.host}, port ${address.port}\n`,
      );
    })
    .catch((error: unknown) => {
      // Only the sanitized reason is reported: never the header, key, or key set.
      const reason =
        error instanceof Error ? error.message : "an unexpected failure";
      process.stderr.write(
        `API key engine MCP HTTP adapter failed to start: ${reason}\n`,
      );
      process.exitCode = 1;
    });
}
