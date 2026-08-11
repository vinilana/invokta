import { errors, Provider, type Configuration } from "oidc-provider";
import type { Pool } from "pg";

import type { OAuthServerConfiguration } from "./server-config.js";
import { createPostgresOidcAdapter } from "./postgres-adapter.js";
import { loadOrCreateOAuthSecrets, type OAuthSecrets } from "./secrets.js";
import { OAuthUserStore } from "./user-store.js";

const accessTokenSeconds = 10 * 60;
const refreshTokenSeconds = 30 * 24 * 60 * 60;
const sessionSeconds = 12 * 60 * 60;
const grantSeconds = 30 * 24 * 60 * 60;

export interface OAuthProviderComposition {
  readonly provider: Provider;
  readonly users: OAuthUserStore;
  readonly csrfKey: string;
}

export interface OAuthProviderConfigurationOptions {
  readonly adapter?: Configuration["adapter"];
  readonly secrets: OAuthSecrets;
  readonly server: OAuthServerConfiguration;
  readonly users: Pick<OAuthUserStore, "findAccount">;
}

interface OAuthRegistrationRequest {
  readonly method?: unknown;
  readonly path?: unknown;
}

function diagnosticToken(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_./-]{1,100}$/.test(value)) {
    return fallback;
  }
  return value;
}

export function formatOAuthRegistrationError(
  request: OAuthRegistrationRequest,
  failure: unknown,
): string {
  const details =
    typeof failure === "object" && failure !== null
      ? (failure as Record<string, unknown>)
      : {};
  const method = diagnosticToken(request.method, "UNKNOWN");
  const path = diagnosticToken(request.path, "unknown");
  const code = diagnosticToken(details.error, "unknown_error");
  const status =
    typeof details.statusCode === "number" &&
    Number.isSafeInteger(details.statusCode) &&
    details.statusCode >= 400 &&
    details.statusCode <= 599
      ? String(details.statusCode)
      : "500";
  return `OAuth client registration failed: method=${method} path=${path} status=${status} code=${code}.\n`;
}

export function createOAuthProviderConfiguration(
  options: OAuthProviderConfigurationOptions,
): Configuration {
  const { adapter, secrets, server, users } = options;
  const secureCookies = server.issuer.startsWith("https://");

  return {
    ...(adapter === undefined ? {} : { adapter }),
    claims: {
      email: null,
      openid: ["sub"],
    },
    clientAuthMethods: [
      "none",
      "client_secret_basic",
      "client_secret_post",
      "private_key_jwt",
    ],
    clientDefaults: {
      grant_types: ["authorization_code", "refresh_token"],
      id_token_signed_response_alg: "ES256",
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_basic",
    },
    cookies: {
      keys: secrets.cookieKeys,
      long: {
        httpOnly: true,
        sameSite: "lax",
        secure: secureCookies,
      },
      short: {
        httpOnly: true,
        sameSite: "lax",
        secure: secureCookies,
      },
    },
    features: {
      devInteractions: { enabled: false },
      // CIMD requires an SSRF-resistant fetch policy that covers DNS
      // resolution, redirects, re-resolution, size, and timeouts. A URL syntax
      // check is not enough, so this example uses DCR until that boundary is
      // provided by its selected Authorization Server library.
      clientIdMetadataDocument: { enabled: false },
      registration: {
        enabled: true,
        initialAccessToken: false,
        issueRegistrationAccessToken: true,
      },
      registrationManagement: {
        enabled: true,
        rotateRegistrationAccessToken: true,
      },
      resourceIndicators: {
        enabled: true,
        defaultResource() {
          return server.resource;
        },
        getResourceServerInfo(_context, resourceIndicator) {
          if (resourceIndicator !== server.resource) {
            throw new errors.InvalidTarget(
              "The requested resource is not this MCP server.",
            );
          }
          return {
            scope: "mcp:tools",
            audience: server.resource,
            accessTokenTTL: accessTokenSeconds,
            accessTokenFormat: "jwt",
            jwt: { sign: { alg: "ES256" } },
          };
        },
        useGrantedResource() {
          return true;
        },
      },
      revocation: { enabled: true },
      userinfo: { enabled: false },
    },
    findAccount: async (_context, subject) => {
      const account = await users.findAccount(subject);
      if (account === null) return undefined;
      return {
        accountId: account.id,
        claims: async () => ({ sub: account.id, email: account.email }),
      };
    },
    interactions: {
      url(_context, interaction) {
        return `/interaction/${encodeURIComponent(interaction.uid)}`;
      },
    },
    issueRefreshToken() {
      return true;
    },
    jwks: secrets.jwks,
    pkce: {
      required() {
        return true;
      },
    },
    responseTypes: ["code"],
    rotateRefreshToken: true,
    scopes: ["openid", "offline_access", "mcp:tools"],
    ttl: {
      AccessToken: accessTokenSeconds,
      AuthorizationCode: 60,
      Grant: grantSeconds,
      Interaction: 10 * 60,
      RefreshToken: refreshTokenSeconds,
      Session: sessionSeconds,
    },
  };
}

export async function createOAuthProvider(
  pool: Pool,
  server: OAuthServerConfiguration,
): Promise<OAuthProviderComposition> {
  const secrets = await loadOrCreateOAuthSecrets(pool);
  const users = new OAuthUserStore(pool);
  const configuration = createOAuthProviderConfiguration({
    adapter: createPostgresOidcAdapter(pool),
    secrets,
    server,
    users,
  });

  const provider = new Provider(server.issuer, configuration);
  provider.proxy = true;
  const csrfKey = secrets.cookieKeys[0];
  if (csrfKey === undefined) {
    throw new Error("OAuth cookie keys are unavailable.");
  }
  return {
    provider,
    users,
    csrfKey,
  };
}
