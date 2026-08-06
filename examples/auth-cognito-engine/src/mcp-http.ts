import { pathToFileURL } from "node:url";

import type { Principal } from "@invokta/core";
import {
  type McpHttpAuthenticationRequest,
  type McpHttpHeaderView,
  type McpHttpProtectedResourceMetadata,
  type McpHttpServerHandle,
  serveMcpHttp,
} from "@invokta/mcp";

import { engine } from "./engine.js";
import { toPrincipal } from "./identity/principal.js";
import {
  type CognitoAccessTokenVerifier,
  cognitoIssuer,
  createCognitoVerifier,
} from "./identity/verifier.js";

/**
 * MCP Streamable HTTP composition root for an Amazon Cognito user pool.
 *
 * The engine stays provider-neutral: Cognito appears only here and in
 * `src/identity/`. Capabilities see a `Principal`, never a token.
 */

export interface CognitoMcpHttpOptions {
  readonly verifier: CognitoAccessTokenVerifier;
  readonly host?: string;
  readonly port?: number;
  /** Published so an OAuth-capable MCP client can discover the user pool. */
  readonly resourceMetadata?: McpHttpProtectedResourceMetadata;
}

// RFC 9110 makes the authentication scheme case-insensitive.
const bearerPattern = /^Bearer ([^\s]+)$/iu;

function readBearerToken(headers: McpHttpHeaderView): string | null {
  const authorization = headers.get("authorization");
  if (authorization === null) return null;
  return bearerPattern.exec(authorization)?.[1] ?? null;
}

/**
 * Builds the `auth.authenticate` hook.
 *
 * Contract, from `docs/http-authentication.md`: a `Principal` for a valid
 * credential, `null` for a missing, malformed, expired, wrong-issuer,
 * wrong-client, or wrong-`token_use` credential (HTTP 401), and a rejection
 * only when verification itself cannot complete (sanitized HTTP 500).
 */
export function createCognitoAuthenticate(
  verifier: CognitoAccessTokenVerifier,
): (request: McpHttpAuthenticationRequest) => Promise<Principal | null> {
  return async (request) => {
    const token = readBearerToken(request.headers);
    if (token === null) return null;

    const identity = await verifier.verify(token, { signal: request.signal });
    return identity === null ? null : toPrincipal(identity);
  };
}

export async function startCognitoMcpHttp(
  options: CognitoMcpHttpOptions,
): Promise<McpHttpServerHandle> {
  return serveMcpHttp(engine, {
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.port === undefined ? {} : { port: options.port }),
    auth: {
      mode: "required",
      authenticate: createCognitoAuthenticate(options.verifier),
      ...(options.resourceMetadata === undefined
        ? {}
        : { resourceMetadata: options.resourceMetadata }),
    },
  });
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function readAppClientIds(): ReadonlyArray<string> {
  const configured = requiredEnv("COGNITO_APP_CLIENT_IDS")
    .split(",")
    .map((clientId) => clientId.trim())
    .filter((clientId) => clientId !== "");
  if (configured.length === 0) {
    throw new Error("COGNITO_APP_CLIENT_IDS must list at least one client id.");
  }
  return configured;
}

export async function main(): Promise<McpHttpServerHandle> {
  const region = requiredEnv("COGNITO_REGION");
  const userPoolId = requiredEnv("COGNITO_USER_POOL_ID");
  const appClientIds = readAppClientIds();

  const configuredPort = process.env.PORT;
  const port = configuredPort === undefined ? 3000 : Number(configuredPort);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("PORT must be an integer between 0 and 65535.");
  }

  // Optional: publish Protected Resource Metadata so an OAuth-capable MCP
  // client can discover the user pool from a 401 challenge. The user pool
  // issuer is the Authorization Server identifier.
  const resource = process.env.COGNITO_RESOURCE_URL;
  const resourceMetadata =
    resource === undefined || resource === ""
      ? undefined
      : {
          resource,
          authorizationServers: [cognitoIssuer(region, userPoolId)] as const,
        };

  return startCognitoMcpHttp({
    port,
    // No secret is read here: the verifier fetches only the public JWKS.
    verifier: createCognitoVerifier({ region, userPoolId, appClientIds }),
    ...(resourceMetadata === undefined ? {} : { resourceMetadata }),
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
        `Cognito engine MCP HTTP adapter listening on host ${address.host}, port ${address.port}\n`,
      );
    })
    .catch(() => {
      // No cause is printed: a startup diagnostic must not echo configuration.
      process.stderr.write(
        "Cognito engine MCP HTTP adapter failed to start.\n",
      );
      process.exitCode = 1;
    });
}
