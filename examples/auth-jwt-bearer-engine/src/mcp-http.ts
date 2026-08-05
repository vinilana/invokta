import { pathToFileURL } from "node:url";

import type { Principal } from "@invokta/core";
import {
  type McpHttpAuthenticationRequest,
  type McpHttpHeaderView,
  type McpHttpProtectedResourceMetadata,
  type McpHttpServerHandle,
  serveMcpHttp,
} from "@invokta/mcp";
import { createRemoteJWKSet } from "jose";

import { engine } from "./engine.js";
import {
  type AccessTokenVerifier,
  createAccessTokenVerifier,
  defaultJwksTimeoutMs,
  resolveJwksUri,
} from "./identity/verifier.js";

/**
 * Reads the Bearer credential from the request headers.
 *
 * The adapter rejects a request carrying more than one raw `Authorization`
 * header before the hook runs, so exactly one value is possible here. The
 * scheme is matched case-insensitively per RFC 9110; anything that is not a
 * single non-whitespace token is treated as "no credential".
 */
export function readBearerToken(headers: McpHttpHeaderView): string | null {
  const authorization = headers.get("authorization");
  if (authorization === null) return null;

  const match = /^Bearer (\S+)$/iu.exec(authorization);
  return match?.[1] ?? null;
}

/**
 * Builds the `authenticate` hook.
 *
 * The three outcomes are deliberate and distinct:
 *
 * - a `Principal` for a credential that verified;
 * - `null` for a missing, malformed, expired, or otherwise invalid credential,
 *   which the adapter answers with HTTP 401;
 * - a rejected promise only when the check could not complete, which the
 *   adapter answers with a sanitized HTTP 500.
 *
 * Never collapse the third case into the second: an unreachable key source is
 * not proof that the caller presented a bad token.
 */
export function createJwtBearerAuthenticate(
  verifier: AccessTokenVerifier,
): (request: McpHttpAuthenticationRequest) => Promise<Principal | null> {
  return async (request) => {
    const token = readBearerToken(request.headers);
    if (token === null) return null;
    // The request signal is handed to the verifier so its I/O ends when the
    // caller disconnects.
    return verifier.verify(token, { signal: request.signal });
  };
}

export interface AuthJwtBearerMcpHttpOptions {
  readonly verifier: AccessTokenVerifier;
  readonly host?: string;
  readonly port?: number;
  readonly allowedHosts?: ReadonlyArray<string>;
  readonly allowedOrigins?: ReadonlyArray<string>;
  /**
   * Publishes RFC 9728 Protected Resource Metadata and adds its discovery URL
   * to the Bearer challenge on 401. Configure it when OAuth-capable MCP clients
   * must discover the Authorization Server on their own.
   */
  readonly resourceMetadata?: McpHttpProtectedResourceMetadata;
}

export async function startAuthJwtBearerMcpHttp(
  options: AuthJwtBearerMcpHttpOptions,
): Promise<McpHttpServerHandle> {
  return serveMcpHttp(engine, {
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.allowedHosts === undefined
      ? {}
      : { allowedHosts: options.allowedHosts }),
    ...(options.allowedOrigins === undefined
      ? {}
      : { allowedOrigins: options.allowedOrigins }),
    auth: {
      mode: "required",
      authenticate: createJwtBearerAuthenticate(options.verifier),
      ...(options.resourceMetadata === undefined
        ? {}
        : { resourceMetadata: options.resourceMetadata }),
    },
  });
}

function requireValue(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function readList(name: string): ReadonlyArray<string> | undefined {
  const value = process.env[name];
  if (value === undefined || value === "") return undefined;
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  if (items.length === 0)
    throw new Error(`${name} must list at least one entry.`);
  return items;
}

function readPort(): number {
  const configured = process.env.PORT;
  const port = configured === undefined ? 3000 : Number(configured);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("PORT must be an integer between 0 and 65535.");
  }
  return port;
}

function readResourceMetadata(
  issuer: string,
): McpHttpProtectedResourceMetadata | undefined {
  const resource = process.env.AUTH_JWT_RESOURCE;
  if (resource === undefined || resource === "") return undefined;

  const configured = readList("AUTH_JWT_AUTHORIZATION_SERVERS");
  const [first, ...rest] = configured ?? [issuer];
  if (first === undefined) {
    throw new Error(
      "AUTH_JWT_AUTHORIZATION_SERVERS must list at least one entry.",
    );
  }
  const scopesSupported = readList("AUTH_JWT_SCOPES_SUPPORTED");

  return {
    resource,
    authorizationServers: [first, ...rest],
    ...(scopesSupported === undefined ? {} : { scopesSupported }),
  };
}

/**
 * Composition root. Every secret-adjacent value comes from the environment, and
 * none of them is ever written to a log.
 *
 *   AUTH_JWT_ISSUER                 exact `iss` value to accept (required)
 *   AUTH_JWT_AUDIENCE               resource identifier expected in `aud`
 *                                     (required; normally this engine's /mcp URL)
 *   AUTH_JWT_JWKS_URI               explicit key-set URL; defaults to the
 *                                     conventional location under the issuer
 *   AUTH_JWT_ALGORITHMS             comma-separated signature allowlist
 *   AUTH_JWT_RESOURCE               public /mcp URL; enables Protected Resource
 *                                     Metadata and the discovery challenge
 *   AUTH_JWT_AUTHORIZATION_SERVERS  comma-separated AS issuers for the metadata
 *                                     document (defaults to AUTH_JWT_ISSUER)
 *   AUTH_JWT_SCOPES_SUPPORTED       comma-separated scopes advertised
 *   AUTH_JWT_HOST                   bind host (default 127.0.0.1)
 *   PORT                            bind port (default 3000)
 *   AUTH_JWT_ALLOWED_HOSTS          Host allowlist, required off loopback
 *   AUTH_JWT_ALLOWED_ORIGINS        browser Origin allowlist
 */
export async function main(): Promise<McpHttpServerHandle> {
  const issuer = requireValue("AUTH_JWT_ISSUER");
  const audience = requireValue("AUTH_JWT_AUDIENCE");
  const algorithms = readList("AUTH_JWT_ALGORITHMS");
  const jwksUri = resolveJwksUri(issuer, process.env.AUTH_JWT_JWKS_URI);

  // The remote key set caches and bounds its own I/O. The verifier still
  // observes the request signal, so a disconnect ends the check as well.
  const getKey = createRemoteJWKSet(new URL(jwksUri), {
    timeoutDuration: defaultJwksTimeoutMs,
    cooldownDuration: 30_000,
    cacheMaxAge: 600_000,
  });

  const host = process.env.AUTH_JWT_HOST;
  const allowedHosts = readList("AUTH_JWT_ALLOWED_HOSTS");
  const allowedOrigins = readList("AUTH_JWT_ALLOWED_ORIGINS");
  const resourceMetadata = readResourceMetadata(issuer);

  return startAuthJwtBearerMcpHttp({
    verifier: createAccessTokenVerifier({
      issuer,
      audience,
      getKey,
      ...(algorithms === undefined ? {} : { algorithms }),
    }),
    ...(host === undefined || host === "" ? {} : { host }),
    port: readPort(),
    ...(allowedHosts === undefined ? {} : { allowedHosts }),
    ...(allowedOrigins === undefined ? {} : { allowedOrigins }),
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
        `Auth JWT bearer engine MCP HTTP adapter listening on host ${address.host}, port ${address.port}\n`,
      );
    })
    .catch(() => {
      // The failure message is dropped: it can name the issuer, the key source,
      // or a value the deployment considers sensitive.
      process.stderr.write(
        "Auth JWT bearer engine MCP HTTP adapter failed to start.\n",
      );
      process.exitCode = 1;
    });
}
