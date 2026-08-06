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
  type BetterAuthTokenVerifier,
  createBetterAuthJwtVerifier,
  createBetterAuthRemoteKeySet,
} from "./identity/verifier.js";

export interface BetterAuthMcpHttpOptions {
  readonly verifier: BetterAuthTokenVerifier;
  readonly host?: string;
  readonly port?: number;
}

// RFC 9110 makes the authentication scheme case-insensitive.
const bearerPattern = /^Bearer ([^\s]+)$/iu;

/**
 * Reads the single Bearer credential the Better Auth client sends. The adapter
 * has already rejected a request carrying more than one `Authorization`
 * header, so there is never an ambiguous credential to choose between.
 */
export function readBearerToken(headers: McpHttpHeaderView): string | null {
  const authorization = headers.get("authorization");
  if (authorization === null) return null;
  return bearerPattern.exec(authorization)?.[1] ?? null;
}

/**
 * The `auth.authenticate` hook: a principal for a verified Better Auth JWT,
 * `null` for every unusable credential, and a thrown error only when the
 * verifier could not complete its check.
 */
export function createBetterAuthAuthenticate(
  verifier: BetterAuthTokenVerifier,
): (request: McpHttpAuthenticationRequest) => Promise<Principal | null> {
  return async (request) => {
    const token = readBearerToken(request.headers);
    if (token === null) return null;

    const claims = await verifier.verify(token, { signal: request.signal });
    return claims === null ? null : toPrincipal(claims);
  };
}

export async function startBetterAuthMcpHttp(
  options: BetterAuthMcpHttpOptions,
): Promise<McpHttpServerHandle> {
  return serveMcpHttp(engine, {
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.port === undefined ? {} : { port: options.port }),
    auth: {
      mode: "required",
      authenticate: createBetterAuthAuthenticate(options.verifier),
    },
  });
}

function readRequired(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required.`);
  }
  return value;
}

export async function main(): Promise<McpHttpServerHandle> {
  // The app that runs Better Auth is the issuer, so one base URL configures
  // key discovery, the issuer check, and the audience check. Override the
  // issuer or audience when the app sets `jwt.issuer` or `jwt.audience`.
  const baseUrl = readRequired("BETTER_AUTH_URL");
  const issuer = process.env.BETTER_AUTH_JWT_ISSUER ?? baseUrl;
  const audience = process.env.BETTER_AUTH_JWT_AUDIENCE ?? baseUrl;
  const configuredPort = process.env.PORT;
  const port = configuredPort === undefined ? 3000 : Number(configuredPort);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("PORT must be an integer between 0 and 65535.");
  }

  return startBetterAuthMcpHttp({
    port,
    verifier: createBetterAuthJwtVerifier({
      issuer,
      audience,
      keys: createBetterAuthRemoteKeySet({ baseUrl }),
    }),
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
        `Better Auth engine MCP HTTP adapter listening on host ${address.host}, port ${address.port}\n`,
      );
    })
    .catch(() => {
      process.stderr.write(
        "Better Auth engine MCP HTTP adapter failed to start.\n",
      );
      process.exitCode = 1;
    });
}
