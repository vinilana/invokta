import { createHash, timingSafeEqual } from "node:crypto";

import type {
  McpHttpAuthenticationRequest,
  McpHttpAuthOptions,
} from "@invokta/mcp";
import { createRemoteJWKSet, jwtVerify } from "jose";

import { EngineStartupError, type EnvironmentRecord } from "./env.js";

const oauthScope = "mcp:tools";
const maximumPrincipalIdLength = 256;

export interface BearerHttpAuthOptions {
  readonly token: string;
  readonly principalId: string;
}

export interface OAuthAccessToken {
  readonly subject: string;
  readonly clientId?: string;
  readonly scopes: readonly string[];
}

export interface OAuthAccessTokenVerifier {
  verify(token: string, signal: AbortSignal): Promise<OAuthAccessToken | null>;
}

export interface OAuthHttpAuthOptions {
  readonly issuer: string;
  readonly resource: string;
  readonly scopes: readonly string[];
  readonly verifier: OAuthAccessTokenVerifier;
}

export type HttpAuthenticationConfiguration =
  | {
      readonly mode: "oauth";
      readonly issuer: string;
      readonly jwksUrl: string;
      readonly resource: string;
      readonly scopes: readonly string[];
    }
  | {
      readonly mode: "bearer";
      readonly token: string;
      readonly principalId: string;
    };

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function readBearerToken(request: McpHttpAuthenticationRequest): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization === null) return null;
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  return match?.[1] ?? null;
}

function requiredValue(environment: EnvironmentRecord, name: string): string {
  const value = environment[name];
  if (value === undefined || value === "") {
    throw new EngineStartupError(`${name} is required.`);
  }
  return value;
}

function secureUrl(
  value: string,
  name: string,
  allowInternalHttp = false,
): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EngineStartupError(`${name} must be an absolute URL.`);
  }
  const loopback =
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "[::1]";
  const internalHttp =
    allowInternalHttp &&
    url.protocol === "http:" &&
    (loopback || !url.hostname.includes("."));
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && loopback) &&
    !internalHttp
  ) {
    throw new EngineStartupError(
      `${name} must use HTTPS except for loopback development.`,
    );
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new EngineStartupError(
      `${name} must not contain credentials, a query, or a fragment.`,
    );
  }
  return url;
}

export function readHttpAuthenticationConfiguration(
  environment: EnvironmentRecord = process.env,
): HttpAuthenticationConfiguration {
  const mode = environment.INVOKTA_HTTP_AUTH_MODE ?? "oauth";
  if (mode === "bearer") {
    const token = requiredValue(environment, "INVOKTA_HTTP_BEARER_TOKEN");
    const principalId = requiredValue(environment, "INVOKTA_HTTP_PRINCIPAL_ID");
    if (token.length < 32) {
      throw new EngineStartupError(
        "INVOKTA_HTTP_BEARER_TOKEN must contain at least 32 characters.",
      );
    }
    if (
      principalId.trim() !== principalId ||
      principalId.length > maximumPrincipalIdLength
    ) {
      throw new EngineStartupError(
        "INVOKTA_HTTP_PRINCIPAL_ID must be trimmed and no longer than 256 characters.",
      );
    }
    return { mode, token, principalId };
  }
  if (mode !== "oauth") {
    throw new EngineStartupError(
      "INVOKTA_HTTP_AUTH_MODE must be either oauth or bearer.",
    );
  }

  const publicUrl = secureUrl(
    requiredValue(environment, "APP_PUBLIC_URL"),
    "APP_PUBLIC_URL",
  );
  if (publicUrl.pathname !== "/") {
    throw new EngineStartupError("APP_PUBLIC_URL must not contain a path.");
  }
  const issuerUrl = secureUrl(
    environment.INVOKTA_OAUTH_ISSUER ?? publicUrl.origin,
    "INVOKTA_OAUTH_ISSUER",
  );
  const jwksUrl = secureUrl(
    environment.INVOKTA_OAUTH_JWKS_URL ?? `${issuerUrl.origin}/jwks`,
    "INVOKTA_OAUTH_JWKS_URL",
    environment.INVOKTA_OAUTH_JWKS_URL !== undefined,
  );

  return {
    mode,
    issuer: issuerUrl.href.replace(/\/$/, ""),
    jwksUrl: jwksUrl.href,
    resource: `${publicUrl.origin}/mcp`,
    scopes: [oauthScope],
  };
}

export function createBearerHttpAuth(options: BearerHttpAuthOptions) {
  const configured = options.token !== "" && options.principalId !== "";
  const expectedDigest = digest(options.token);

  return {
    mode: "required",
    authenticate(request) {
      if (!configured) return null;
      const received = readBearerToken(request);
      if (received === null) return null;
      if (!timingSafeEqual(expectedDigest, digest(received))) return null;
      return { id: options.principalId };
    },
  } satisfies McpHttpAuthOptions;
}

export function createOAuthHttpAuth(options: OAuthHttpAuthOptions) {
  const requiredScopes = new Set(options.scopes);
  return {
    mode: "required",
    challengeScopes: [...options.scopes],
    resourceMetadata: {
      resource: options.resource,
      authorizationServers: [options.issuer] as [string],
      scopesSupported: [...options.scopes],
    },
    async authenticate(request: McpHttpAuthenticationRequest) {
      const token = readBearerToken(request);
      if (token === null) return null;
      const verified = await options.verifier.verify(token, request.signal);
      if (verified === null || verified.subject === "") return null;
      const grantedScopes = new Set(verified.scopes);
      if ([...requiredScopes].some((scope) => !grantedScopes.has(scope))) {
        return null;
      }
      return {
        id: verified.subject,
        attributes: {
          ...(verified.clientId === undefined
            ? {}
            : { clientId: verified.clientId }),
          scopes: [...verified.scopes],
        },
      };
    },
  } satisfies McpHttpAuthOptions;
}

export function createJwtAccessTokenVerifier(options: {
  readonly issuer: string;
  readonly resource: string;
  readonly jwksUrl: string;
}): OAuthAccessTokenVerifier {
  const jwks = createRemoteJWKSet(new URL(options.jwksUrl));
  return {
    async verify(token, signal) {
      if (signal.aborted) return null;
      try {
        const { payload } = await jwtVerify(token, jwks, {
          issuer: options.issuer,
          audience: options.resource,
        });
        if (signal.aborted || typeof payload.sub !== "string") return null;
        const scope = typeof payload.scope === "string" ? payload.scope : "";
        const scopes = scope.split(" ").filter((item) => item !== "");
        return {
          subject: payload.sub,
          ...(typeof payload.client_id === "string"
            ? { clientId: payload.client_id }
            : {}),
          scopes,
        };
      } catch {
        return null;
      }
    },
  };
}

export function createHttpAuth(
  configuration: HttpAuthenticationConfiguration,
): McpHttpAuthOptions {
  if (configuration.mode === "bearer") {
    return createBearerHttpAuth(configuration);
  }
  return createOAuthHttpAuth({
    issuer: configuration.issuer,
    resource: configuration.resource,
    scopes: configuration.scopes,
    verifier: createJwtAccessTokenVerifier(configuration),
  });
}
