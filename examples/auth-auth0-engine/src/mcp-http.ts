import { pathToFileURL } from "node:url";

import type { JwtKeySource } from "@invokta/auth-jwt";
import { type McpHttpServerHandle, serveMcpHttp } from "@invokta/mcp";

import { engine } from "./engine.js";
import {
  auth0Issuer,
  createAuth0Authenticator,
} from "./identity/authenticator.js";

export interface Auth0McpHttpOptions {
  /** Auth0 tenant or custom domain. */
  readonly domain: string;
  /** The API identifier registered in Auth0. */
  readonly audience: string;
  /** Injected in tests; production wiring uses the tenant's remote JWKS. */
  readonly keySource?: JwtKeySource;
  readonly host?: string;
  readonly port?: number;
  /** Public `/mcp` URL, published as Protected Resource Metadata. */
  readonly resource?: string;
  readonly scopesSupported?: ReadonlyArray<string>;
  /**
   * The ordered base scopes serialized into the 401 Bearer challenge. The
   * challenge is authoritative for the current request, while
   * `scopesSupported` describes the minimal generally supported set, so an
   * Auth0 API that requires a scope for every call names it here. Requires
   * `resource`.
   */
  readonly challengeScopes?: ReadonlyArray<string>;
}

export async function startAuth0McpHttp(
  options: Auth0McpHttpOptions,
): Promise<McpHttpServerHandle> {
  const authenticate = createAuth0Authenticator({
    domain: options.domain,
    audience: options.audience,
    ...(options.keySource === undefined
      ? {}
      : { keySource: options.keySource }),
  });
  const authorizationServers: readonly [string, ...string[]] = [
    auth0Issuer(options.domain),
  ];

  return serveMcpHttp(engine, {
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.port === undefined ? {} : { port: options.port }),
    auth: {
      mode: "required",
      authenticate,
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

function readPort(): number {
  const configured = process.env.PORT;
  const port = configured === undefined ? 3000 : Number(configured);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("PORT must be an integer between 0 and 65535.");
  }
  return port;
}

function readScopes(name: string): ReadonlyArray<string> | undefined {
  const value = process.env[name];
  if (value === undefined || value === "") return undefined;
  const scopes = value.split(/[\s,]+/u).filter((scope) => scope !== "");
  return scopes.length === 0 ? undefined : scopes;
}

export async function main(): Promise<McpHttpServerHandle> {
  const resource = process.env.AUTH0_MCP_RESOURCE;
  const scopesSupported = readScopes("AUTH0_MCP_SCOPES");
  const challengeScopes = readScopes("AUTH0_MCP_CHALLENGE_SCOPES");
  if (
    challengeScopes !== undefined &&
    (resource === undefined || resource === "")
  ) {
    throw new Error("AUTH0_MCP_CHALLENGE_SCOPES requires AUTH0_MCP_RESOURCE.");
  }
  return startAuth0McpHttp({
    domain: requireEnvironment("AUTH0_DOMAIN"),
    audience: requireEnvironment("AUTH0_AUDIENCE"),
    port: readPort(),
    ...(resource === undefined || resource === "" ? {} : { resource }),
    ...(scopesSupported === undefined ? {} : { scopesSupported }),
    ...(challengeScopes === undefined ? {} : { challengeScopes }),
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
