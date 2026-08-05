import { pathToFileURL } from "node:url";

import type { Principal } from "@invokta/core";
import {
  type McpHttpAuthenticationRequest,
  type McpHttpHeaderView,
  type McpHttpServerHandle,
  serveMcpHttp,
} from "@invokta/mcp";

import { engine } from "./engine.js";
import { toSupabasePrincipal } from "./identity/principal.js";
import {
  createSupabaseProjectVerifier,
  type SupabaseAccessTokenVerifier,
} from "./identity/verifier.js";

const BEARER_PATTERN = /^Bearer (\S+)$/;

/**
 * Reads the single bearer credential. The adapter has already rejected
 * requests carrying more than one raw `Authorization` header, so there is
 * never an ambiguous credential to choose between.
 */
export function readBearerToken(headers: McpHttpHeaderView): string | null {
  const authorization = headers.get("authorization");
  if (authorization === null) return null;
  return BEARER_PATTERN.exec(authorization)?.[1] ?? null;
}

/**
 * The `auth.authenticate` hook: a principal for a verified Supabase access
 * token, null for any missing or invalid credential, and a rejected promise
 * only when the verifier could not complete its check.
 */
export function createSupabaseAuthenticate(
  verifier: SupabaseAccessTokenVerifier,
): (request: McpHttpAuthenticationRequest) => Promise<Principal | null> {
  return async (request) => {
    const token = readBearerToken(request.headers);
    if (token === null) return null;

    const identity = await verifier.verify(token, { signal: request.signal });
    return identity === null ? null : toSupabasePrincipal(identity);
  };
}

export interface SupabaseMcpHttpOptions {
  readonly verifier: SupabaseAccessTokenVerifier;
  readonly host?: string;
  readonly port?: number;
}

export async function startSupabaseMcpHttp(
  options: SupabaseMcpHttpOptions,
): Promise<McpHttpServerHandle> {
  return serveMcpHttp(engine, {
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.port === undefined ? {} : { port: options.port }),
    auth: {
      mode: "required",
      authenticate: createSupabaseAuthenticate(options.verifier),
    },
  });
}

export async function main(): Promise<McpHttpServerHandle> {
  const projectUrl = process.env.SUPABASE_URL;
  if (projectUrl === undefined || projectUrl === "") {
    throw new Error("SUPABASE_URL is required.");
  }
  const configuredPort = process.env.PORT;
  const port = configuredPort === undefined ? 3000 : Number(configuredPort);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("PORT must be an integer between 0 and 65535.");
  }
  const audience = process.env.SUPABASE_JWT_AUDIENCE;

  return startSupabaseMcpHttp({
    port,
    verifier: createSupabaseProjectVerifier({
      projectUrl,
      ...(audience === undefined || audience === "" ? {} : { audience }),
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
        `Supabase auth engine MCP HTTP adapter listening on host ${address.host}, port ${address.port}\n`,
      );
    })
    .catch(() => {
      process.stderr.write(
        "Supabase auth engine MCP HTTP adapter failed to start.\n",
      );
      process.exitCode = 1;
    });
}
