import { pathToFileURL } from "node:url";

import type { Principal } from "@invokta/core";
import {
  type McpHttpAuthenticationRequest,
  type McpHttpProtectedResourceMetadata,
  type McpHttpServerHandle,
  serveMcpHttp,
} from "@invokta/mcp";

import { engine } from "./engine.js";
import { toPrincipal } from "./identity/principal.js";
import {
  createWorkOsAccessTokenVerifier,
  WORKOS_DEFAULT_ISSUER,
  type WorkOsAccessTokenVerifier,
} from "./identity/verifier.js";

export interface WorkOsMcpHttpOptions {
  readonly verifier: WorkOsAccessTokenVerifier;
  readonly host?: string;
  readonly port?: number;
  readonly resourceMetadata?: McpHttpProtectedResourceMetadata;
}

const bearerPattern = /^Bearer ([^\s]+)$/i;

function readBearerToken(request: McpHttpAuthenticationRequest): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization === null) return null;
  return bearerPattern.exec(authorization)?.[1] ?? null;
}

/**
 * Builds the `auth.authenticate` hook for a WorkOS-protected engine.
 *
 * A missing, malformed, expired, or otherwise invalid access token resolves to
 * `null`, which the adapter answers with HTTP 401. A verification
 * infrastructure failure rejects, which the adapter answers with a sanitized
 * HTTP 500; the hook never converts an unknown fault into a 401.
 */
export function createWorkOsAuthenticate(
  verifier: WorkOsAccessTokenVerifier,
): (request: McpHttpAuthenticationRequest) => Promise<Principal | null> {
  return async (request) => {
    const token = readBearerToken(request);
    if (token === null) return null;

    const claims = await verifier.verify(token, { signal: request.signal });
    return claims === null ? null : toPrincipal(claims);
  };
}

export async function startWorkOsMcpHttp(
  options: WorkOsMcpHttpOptions,
): Promise<McpHttpServerHandle> {
  return serveMcpHttp(engine, {
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.port === undefined ? {} : { port: options.port }),
    auth: {
      mode: "required",
      authenticate: createWorkOsAuthenticate(options.verifier),
      ...(options.resourceMetadata === undefined
        ? {}
        : { resourceMetadata: options.resourceMetadata }),
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
  // The client id selects the WorkOS JWKS; no API key or client secret is
  // needed to verify an access token at this boundary.
  const clientId = requireEnvironment("WORKOS_CLIENT_ID");
  const issuer = process.env.WORKOS_ISSUER ?? WORKOS_DEFAULT_ISSUER;
  const jwksUrl = process.env.WORKOS_JWKS_URL;
  // The resource indicator registered in AuthKit. It is both the expected
  // `aud` claim and the resource this server publishes for discovery.
  const resource = process.env.WORKOS_MCP_RESOURCE;
  const configuredPort = process.env.PORT;
  const port = configuredPort === undefined ? 3000 : Number(configuredPort);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("PORT must be an integer between 0 and 65535.");
  }

  const resourceMetadata: McpHttpProtectedResourceMetadata | undefined =
    resource === undefined || resource === ""
      ? undefined
      : { resource, authorizationServers: [issuer] };

  return startWorkOsMcpHttp({
    verifier: createWorkOsAccessTokenVerifier({
      clientId,
      issuer,
      ...(jwksUrl === undefined || jwksUrl === "" ? {} : { jwksUrl }),
      ...(resource === undefined || resource === ""
        ? {}
        : { audience: resource }),
    }),
    port,
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
        `WorkOS auth engine MCP HTTP adapter listening on host ${address.host}, port ${address.port}\n`,
      );
    })
    .catch(() => {
      process.stderr.write(
        "WorkOS auth engine MCP HTTP adapter failed to start.\n",
      );
      process.exitCode = 1;
    });
}
