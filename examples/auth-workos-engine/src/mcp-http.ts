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
  type WorkOsAccessTokenVerifier,
  type WorkOsVerifierOptions,
  workOsAuthKitJwksUrl,
} from "./identity/verifier.js";

export interface WorkOsMcpHttpOptions {
  readonly verifier: WorkOsAccessTokenVerifier;
  readonly host?: string;
  readonly port?: number;
  readonly resourceMetadata?: McpHttpProtectedResourceMetadata;
  /**
   * The ordered base scopes serialized into the 401 Bearer challenge, so an
   * MCP client asks AuthKit for them on its first authorization request. The
   * challenge is authoritative for the current request; the metadata's
   * `scopesSupported` describes the minimal generally supported set. Requires
   * `resourceMetadata`.
   */
  readonly challengeScopes?: ReadonlyArray<string>;
}

// RFC 9110 makes the authentication scheme case-insensitive.
const bearerPattern = /^Bearer ([^\s]+)$/iu;

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
        : {
            resourceMetadata: options.resourceMetadata,
            // The adapter refuses challenge scopes without metadata, so they
            // stay inside the branch that publishes it.
            ...(options.challengeScopes === undefined
              ? {}
              : { challengeScopes: options.challengeScopes }),
          }),
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

function readEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
}

export interface WorkOsBoundaryConfiguration {
  readonly verifier: WorkOsVerifierOptions;
  readonly resourceMetadata?: McpHttpProtectedResourceMetadata;
  readonly challengeScopes?: ReadonlyArray<string>;
}

function readScopeList(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): ReadonlyArray<string> | undefined {
  const value = readEnvironment(env, name);
  if (value === undefined) return undefined;
  const scopes = value.split(/[\s,]+/u).filter((scope) => scope !== "");
  if (scopes.length === 0) {
    throw new Error(`${name} must list at least one scope.`);
  }
  return scopes;
}

/**
 * Resolves which WorkOS token flavor this deployment verifies.
 *
 * WorkOS issues two flavors with different issuers and key sets:
 *
 * - AuthKit **session** access tokens, the ones an application holding a
 *   WorkOS session already has: `iss` is `https://api.workos.com/` (or the
 *   custom auth domain), the JWKS is `sso/jwks/<clientId>`, and there is no
 *   `aud` claim. This is the default flavor, selected when no MCP resource is
 *   configured.
 * - **MCP OAuth** tokens obtained through resource indicators: issuer,
 *   authorization server, and JWKS all live on the environment's AuthKit
 *   domain (`https://<environment>.authkit.app`, JWKS at `/oauth2/jwks`), and
 *   `aud` is bound to the registered resource. Selected when
 *   `WORKOS_MCP_RESOURCE` is set, which then requires `WORKOS_AUTHKIT_DOMAIN`
 *   (or explicit `WORKOS_ISSUER` and `WORKOS_JWKS_URL` overrides) — the
 *   session-flavor defaults would answer 401 to both flavors and advertise an
 *   authorization server that serves no AS metadata.
 */
export function resolveWorkOsConfiguration(
  env: Readonly<Record<string, string | undefined>>,
): WorkOsBoundaryConfiguration {
  const clientId = env.WORKOS_CLIENT_ID;
  if (clientId === undefined || clientId === "") {
    throw new Error("WORKOS_CLIENT_ID is required.");
  }
  const resource = readEnvironment(env, "WORKOS_MCP_RESOURCE");
  const authKitDomain = readEnvironment(env, "WORKOS_AUTHKIT_DOMAIN");
  const issuerOverride = readEnvironment(env, "WORKOS_ISSUER");
  const jwksOverride = readEnvironment(env, "WORKOS_JWKS_URL");
  const challengeScopes = readScopeList(env, "WORKOS_MCP_CHALLENGE_SCOPES");

  if (resource === undefined) {
    if (challengeScopes !== undefined) {
      // Challenge scopes are part of Protected Resource Metadata, which the
      // session-token flavor does not publish.
      throw new Error(
        "WORKOS_MCP_CHALLENGE_SCOPES requires WORKOS_MCP_RESOURCE.",
      );
    }
    return {
      verifier: {
        clientId,
        ...(issuerOverride === undefined ? {} : { issuer: issuerOverride }),
        ...(jwksOverride === undefined ? {} : { jwksUrl: jwksOverride }),
      },
    };
  }

  const issuer = issuerOverride ?? authKitDomain;
  const jwksUrl =
    jwksOverride ??
    (authKitDomain === undefined
      ? undefined
      : workOsAuthKitJwksUrl(authKitDomain).href);
  if (issuer === undefined || jwksUrl === undefined) {
    throw new Error(
      "WORKOS_MCP_RESOURCE requires WORKOS_AUTHKIT_DOMAIN, or explicit WORKOS_ISSUER and WORKOS_JWKS_URL overrides.",
    );
  }

  return {
    verifier: { clientId, issuer, jwksUrl, audience: resource },
    resourceMetadata: { resource, authorizationServers: [issuer] },
    ...(challengeScopes === undefined ? {} : { challengeScopes }),
  };
}

export async function main(): Promise<McpHttpServerHandle> {
  // The client id selects the WorkOS JWKS; no API key or client secret is
  // needed to verify an access token at this boundary.
  requireEnvironment("WORKOS_CLIENT_ID");
  const configuration = resolveWorkOsConfiguration(process.env);
  const configuredPort = process.env.PORT;
  const port = configuredPort === undefined ? 3000 : Number(configuredPort);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("PORT must be an integer between 0 and 65535.");
  }

  return startWorkOsMcpHttp({
    verifier: createWorkOsAccessTokenVerifier(configuration.verifier),
    port,
    ...(configuration.resourceMetadata === undefined
      ? {}
      : { resourceMetadata: configuration.resourceMetadata }),
    ...(configuration.challengeScopes === undefined
      ? {}
      : { challengeScopes: configuration.challengeScopes }),
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
