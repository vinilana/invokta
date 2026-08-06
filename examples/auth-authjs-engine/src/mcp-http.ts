import { pathToFileURL } from "node:url";

import type { Principal } from "@invokta/core";
import {
  type McpHttpAuthenticationRequest,
  type McpHttpServerHandle,
  serveMcpHttp,
} from "@invokta/mcp";
import { createRemoteJWKSet } from "jose";

import { engine } from "./engine.js";
import { accessTokenToPrincipal } from "./identity/principal.js";
import {
  createEngineAccessTokenVerifier,
  type EngineAccessTokenVerifier,
} from "./identity/verifier.js";

/**
 * The secondary Auth.js surface: MCP HTTP for callers that cannot invoke the
 * engine in process.
 *
 * The credential is the application's own short-lived access token, never the
 * Auth.js session cookie. See src/identity/verifier.ts for why.
 */

// RFC 9110 makes the authentication scheme case-insensitive.
const bearerPattern = /^Bearer ([^\s]+)$/iu;

export function readBearerToken(
  headers: McpHttpAuthenticationRequest["headers"],
): string | null {
  const authorization = headers.get("authorization");
  if (authorization === null) return null;
  return bearerPattern.exec(authorization)?.[1] ?? null;
}

export function createAuthjsAuthenticate(
  verifier: EngineAccessTokenVerifier,
): (request: McpHttpAuthenticationRequest) => Promise<Principal | null> {
  return async (request) => {
    const token = readBearerToken(request.headers);
    if (token === null) return null;

    const verified = await verifier.verify(token, { signal: request.signal });
    return verified === null ? null : accessTokenToPrincipal(verified);
  };
}

export interface AuthjsMcpHttpOptions {
  readonly verifier: EngineAccessTokenVerifier;
  readonly host?: string;
  readonly port?: number;
}

export async function startAuthjsMcpHttp(
  options: AuthjsMcpHttpOptions,
): Promise<McpHttpServerHandle> {
  return serveMcpHttp(engine, {
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.port === undefined ? {} : { port: options.port }),
    auth: {
      mode: "required",
      authenticate: createAuthjsAuthenticate(options.verifier),
    },
  });
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required.`);
  }
  return value;
}

export async function main(): Promise<McpHttpServerHandle> {
  // All three values describe this application, not Auth.js: the engine trusts
  // the token issuer the application runs, and only for this audience.
  const issuer = requireEnvironment("AUTHJS_ENGINE_TOKEN_ISSUER");
  const audience = requireEnvironment("AUTHJS_ENGINE_TOKEN_AUDIENCE");
  const jwksUrl = requireEnvironment("AUTHJS_ENGINE_JWKS_URL");

  const configuredPort = process.env.PORT;
  const port = configuredPort === undefined ? 3000 : Number(configuredPort);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("PORT must be an integer between 0 and 65535.");
  }

  const verifier = createEngineAccessTokenVerifier({
    resolveKey: createRemoteJWKSet(new URL(jwksUrl), {
      timeoutDuration: 2_000,
      cooldownDuration: 30_000,
    }),
    issuer,
    audience,
  });

  return startAuthjsMcpHttp({ verifier, port });
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
        `Auth.js engine MCP HTTP adapter listening on host ${address.host}, port ${address.port}\n`,
      );
    })
    .catch(() => {
      process.stderr.write(
        "Auth.js engine MCP HTTP adapter failed to start.\n",
      );
      process.exitCode = 1;
    });
}
