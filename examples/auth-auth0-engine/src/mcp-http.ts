import { pathToFileURL } from "node:url";

import type { Principal } from "@invokta/core";
import {
  type McpHttpAuthenticationRequest,
  type McpHttpHeaderView,
  type McpHttpServerHandle,
  serveMcpHttp,
} from "@invokta/mcp";

import { engine } from "./engine.js";
import { toAuth0Principal } from "./identity/principal.js";
import {
  type Auth0AccessTokenVerifier,
  auth0Issuer,
  createAuth0AccessTokenVerifier,
} from "./identity/verifier.js";

// RFC 9110 makes the authentication scheme case-insensitive.
const bearerCredential = /^Bearer ([^\s]+)$/iu;

/**
 * Reads the bearer credential. The adapter has already rejected a request
 * carrying more than one raw `Authorization` header, so there is never an
 * ambiguous credential to choose between here.
 */
export function readBearerToken(headers: McpHttpHeaderView): string | null {
  const authorization = headers.get("authorization");
  if (authorization === null) return null;
  return bearerCredential.exec(authorization)?.[1] ?? null;
}

/**
 * The `auth.authenticate` hook: `Principal` for a verified Auth0 access token,
 * `null` for every invalid or missing credential, and a rejection only when
 * the check itself could not run.
 */
export function createAuth0Authenticate(
  verifier: Auth0AccessTokenVerifier,
): (request: McpHttpAuthenticationRequest) => Promise<Principal | null> {
  return async (request) => {
    const token = readBearerToken(request.headers);
    if (token === null) return null;

    const claims = await verifier.verify(token, { signal: request.signal });
    return claims === null ? null : toAuth0Principal(claims);
  };
}

export interface Auth0McpHttpOptions {
  /** Auth0 tenant or custom domain. */
  readonly domain: string;
  /** The API identifier registered in Auth0. */
  readonly audience: string;
  /** Injected in tests; production wiring uses the tenant's remote JWKS. */
  readonly verifier?: Auth0AccessTokenVerifier;
  readonly host?: string;
  readonly port?: number;
  /** Public `/mcp` URL, published as Protected Resource Metadata. */
  readonly resource?: string;
  readonly scopesSupported?: ReadonlyArray<string>;
}

export async function startAuth0McpHttp(
  options: Auth0McpHttpOptions,
): Promise<McpHttpServerHandle> {
  const verifier =
    options.verifier ??
    createAuth0AccessTokenVerifier({
      domain: options.domain,
      audience: options.audience,
    });
  const authorizationServers: readonly [string, ...string[]] = [
    auth0Issuer(options.domain),
  ];

  return serveMcpHttp(engine, {
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.port === undefined ? {} : { port: options.port }),
    auth: {
      mode: "required",
      authenticate: createAuth0Authenticate(verifier),
      ...(options.resource === undefined
        ? {}
        : {
            resourceMetadata: {
              resource: options.resource,
              authorizationServers,
              ...(options.scopesSupported === undefined
                ? {}
                : { scopesSupported: options.scopesSupported }),
            },
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

function readPort(): number {
  const configured = process.env.PORT;
  const port = configured === undefined ? 3000 : Number(configured);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("PORT must be an integer between 0 and 65535.");
  }
  return port;
}

export async function main(): Promise<McpHttpServerHandle> {
  const resource = process.env.AUTH0_MCP_RESOURCE;
  const scopes = process.env.AUTH0_MCP_SCOPES;
  return startAuth0McpHttp({
    domain: requireEnvironment("AUTH0_DOMAIN"),
    audience: requireEnvironment("AUTH0_AUDIENCE"),
    port: readPort(),
    ...(resource === undefined || resource === "" ? {} : { resource }),
    ...(scopes === undefined || scopes === ""
      ? {}
      : {
          scopesSupported: scopes
            .split(/[\s,]+/u)
            .filter((scope) => scope !== ""),
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
        `Auth0 engine MCP HTTP adapter listening on host ${address.host}, port ${address.port}\n`,
      );
    })
    .catch(() => {
      process.stderr.write("Auth0 engine MCP HTTP adapter failed to start.\n");
      process.exitCode = 1;
    });
}
