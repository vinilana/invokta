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
  type ClerkSessionVerifier,
  createClerkRemoteKeys,
  createClerkSessionVerifier,
} from "./identity/verifier.js";

// RFC 9110 makes the authentication scheme case-insensitive.
const BEARER_CREDENTIAL = /^Bearer ([^\s]+)$/iu;
const DEFAULT_PORT = 3000;
const MAXIMUM_PORT = 65_535;

function readBearerToken(headers: McpHttpHeaderView): string | null {
  const authorization = headers.get("authorization");
  if (authorization === null) return null;
  return BEARER_CREDENTIAL.exec(authorization)?.[1] ?? null;
}

/**
 * The `auth.authenticate` hook: a `Principal` for a verified Clerk session
 * token, `null` for every invalid or missing credential, and a rejection only
 * when the verifier could not complete its check.
 */
export function createClerkAuthenticate(
  verifier: ClerkSessionVerifier,
): (request: McpHttpAuthenticationRequest) => Promise<Principal | null> {
  return async (request) => {
    const token = readBearerToken(request.headers);
    if (token === null) return null;

    const claims = await verifier.verify(token, { signal: request.signal });
    return claims === null ? null : toPrincipal(claims);
  };
}

export interface ClerkMcpHttpOptions {
  readonly verifier: ClerkSessionVerifier;
  readonly host?: string;
  readonly port?: number;
}

export async function startClerkMcpHttp(
  options: ClerkMcpHttpOptions,
): Promise<McpHttpServerHandle> {
  return serveMcpHttp(engine, {
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.port === undefined ? {} : { port: options.port }),
    auth: {
      mode: "required",
      authenticate: createClerkAuthenticate(options.verifier),
    },
  });
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
}

function requireEnvironmentList(name: string): ReadonlyArray<string> {
  const entries = requireEnvironment(name)
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  if (entries.length === 0) {
    throw new Error(`${name} must list at least one entry.`);
  }
  return entries;
}

export async function main(): Promise<McpHttpServerHandle> {
  const frontendApiUrl = requireEnvironment("CLERK_FRONTEND_API_URL");
  // Clerk recommends an explicit authorized-party allowlist, so this engine
  // refuses to start without one instead of accepting every origin.
  const authorizedParties = requireEnvironmentList("CLERK_AUTHORIZED_PARTIES");
  const configuredPort = process.env.PORT;
  const port =
    configuredPort === undefined ? DEFAULT_PORT : Number(configuredPort);
  if (!Number.isInteger(port) || port < 0 || port > MAXIMUM_PORT) {
    throw new Error(`PORT must be an integer between 0 and ${MAXIMUM_PORT}.`);
  }

  return startClerkMcpHttp({
    verifier: createClerkSessionVerifier({
      frontendApiUrl,
      authorizedParties,
      // With an allowlist configured, an azp-less token (custom JWT template,
      // machine token) is rejected too — otherwise it would bypass the
      // allowlist this composition root just required. Construct the verifier
      // without this flag when such callers are legitimate.
      requireAuthorizedParty: true,
      keys: createClerkRemoteKeys(frontendApiUrl),
    }),
    port,
  });
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
        `Clerk auth example MCP HTTP adapter listening on host ${address.host}, port ${address.port}\n`,
      );
    })
    .catch(() => {
      process.stderr.write(
        "Clerk auth example MCP HTTP adapter failed to start.\n",
      );
      process.exitCode = 1;
    });
}
