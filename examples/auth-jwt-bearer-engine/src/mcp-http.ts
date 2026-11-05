import { pathToFileURL } from "node:url";

import {
  createJwtBearerAuthenticator,
  isJwtSignatureAlgorithm,
  type JwtBearerAuthenticator,
  type JwtSignatureAlgorithm,
} from "@invokta/auth-jwt";
import {
  type McpHttpProtectedResourceMetadata,
  type McpHttpServerHandle,
  serveMcpHttp,
} from "@invokta/mcp";

import { engine } from "./engine.js";
import { resolveJwksUri } from "./identity/jwks-location.js";

/**
 * Signature algorithms accepted when `AUTH_JWT_ALGORITHMS` is unset. The
 * authenticator requires an explicit allowlist: without one, a token could
 * choose its own algorithm.
 */
export const defaultSignatureAlgorithms: ReadonlyArray<JwtSignatureAlgorithm> =
  Object.freeze(["RS256", "ES256"]);

export interface AuthJwtBearerMcpHttpOptions {
  /**
   * The `@invokta/auth-jwt` authenticator. It resolves a `Principal` for a
   * verified token, `null` for a missing or invalid credential (HTTP 401), and
   * rejects only when the check could not complete (sanitized HTTP 500).
   */
  readonly authenticate: JwtBearerAuthenticator;
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
  /**
   * The ordered base scopes this Resource Server requires, serialized into the
   * 401 Bearer challenge. They are deliberately separate from the metadata's
   * `scopesSupported`: the challenge is authoritative for the current request,
   * while the metadata describes the minimal generally supported set. The
   * adapter requires `resourceMetadata` alongside them, and omitting them is
   * correct when the policy cannot name a stable base set. When the
   * authenticator has `requiredScopes`, list them here so a client holding a
   * token without them learns what to request.
   */
  readonly challengeScopes?: ReadonlyArray<string>;
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
      authenticate: options.authenticate,
      ...(options.resourceMetadata === undefined
        ? {}
        : { resourceMetadata: options.resourceMetadata }),
      ...(options.challengeScopes === undefined
        ? {}
        : { challengeScopes: options.challengeScopes }),
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

function readAlgorithms(): ReadonlyArray<JwtSignatureAlgorithm> {
  const configured = readList("AUTH_JWT_ALGORITHMS");
  if (configured === undefined) return defaultSignatureAlgorithms;
  const algorithms = configured.filter(isJwtSignatureAlgorithm);
  if (algorithms.length !== configured.length) {
    throw new Error(
      "AUTH_JWT_ALGORITHMS may list only asymmetric JWS algorithms such as RS256 or ES256.",
    );
  }
  return algorithms;
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
 * Challenge scopes require Protected Resource Metadata, so an operator who
 * names them without a resource is told which value is missing instead of
 * getting a `TypeError` from the adapter's own validation.
 */
function readChallengeScopes(
  resourceMetadata: McpHttpProtectedResourceMetadata | undefined,
): ReadonlyArray<string> | undefined {
  const scopes = readList("AUTH_JWT_CHALLENGE_SCOPES");
  if (scopes === undefined) return undefined;
  if (resourceMetadata === undefined) {
    throw new Error("AUTH_JWT_CHALLENGE_SCOPES requires AUTH_JWT_RESOURCE.");
  }
  return scopes;
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
 *   AUTH_JWT_REQUIRED_SCOPES        comma-separated scopes every token must
 *                                     grant; list them in
 *                                     AUTH_JWT_CHALLENGE_SCOPES as well
 *   AUTH_JWT_RESOURCE               public /mcp URL; enables Protected Resource
 *                                     Metadata and the discovery challenge
 *   AUTH_JWT_AUTHORIZATION_SERVERS  comma-separated AS issuers for the metadata
 *                                     document (defaults to AUTH_JWT_ISSUER)
 *   AUTH_JWT_SCOPES_SUPPORTED       comma-separated scopes advertised
 *   AUTH_JWT_CHALLENGE_SCOPES       comma-separated ordered scopes serialized
 *                                     into the 401 Bearer challenge; requires
 *                                     AUTH_JWT_RESOURCE
 *   AUTH_JWT_HOST                   bind host (default 127.0.0.1)
 *   PORT                            bind port (default 3000)
 *   AUTH_JWT_ALLOWED_HOSTS          Host allowlist, required off loopback
 *   AUTH_JWT_ALLOWED_ORIGINS        browser Origin allowlist
 */
export async function main(): Promise<McpHttpServerHandle> {
  const issuer = requireValue("AUTH_JWT_ISSUER");
  const requiredScopes = readList("AUTH_JWT_REQUIRED_SCOPES");

  // The remote key set is fetched on first use with a bounded timeout, cached,
  // and refetched for an unknown key at most once per cooldown. The
  // authenticator also observes the request signal, so a disconnect ends the
  // check.
  const authenticate = createJwtBearerAuthenticator({
    issuer,
    audience: requireValue("AUTH_JWT_AUDIENCE"),
    algorithms: readAlgorithms(),
    jwksUrl: resolveJwksUri(issuer, process.env.AUTH_JWT_JWKS_URI),
    ...(requiredScopes === undefined ? {} : { requiredScopes }),
  });

  const host = process.env.AUTH_JWT_HOST;
  const allowedHosts = readList("AUTH_JWT_ALLOWED_HOSTS");
  const allowedOrigins = readList("AUTH_JWT_ALLOWED_ORIGINS");
  const resourceMetadata = readResourceMetadata(issuer);
  const challengeScopes = readChallengeScopes(resourceMetadata);

  return startAuthJwtBearerMcpHttp({
    authenticate,
    ...(host === undefined || host === "" ? {} : { host }),
    port: readPort(),
    ...(allowedHosts === undefined ? {} : { allowedHosts }),
    ...(allowedOrigins === undefined ? {} : { allowedOrigins }),
    ...(resourceMetadata === undefined ? {} : { resourceMetadata }),
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
