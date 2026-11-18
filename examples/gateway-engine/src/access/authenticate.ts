import { createJwtBearerAuthenticator } from "@invokta/auth-jwt";
import {
  type ApiKeyCredential,
  apiKeyAuthenticator,
  chainAuthenticators,
  type GatewayAuthenticator,
} from "@invokta/gateway";

const MAX_CONFIGURED_KEYS = 100;

/**
 * Parses `GATEWAY_API_KEYS`: a JSON array of
 * `{ "id", "sha256", "scopes"?, "agent"? }`. Only digests are configured;
 * `npm run hash-key` prints the digest of a key read from stdin.
 */
export function parseApiKeys(json: string): ReadonlyArray<ApiKeyCredential> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new TypeError("GATEWAY_API_KEYS must be a JSON array.");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.length > MAX_CONFIGURED_KEYS
  ) {
    throw new TypeError(
      `GATEWAY_API_KEYS must list 1 to ${String(MAX_CONFIGURED_KEYS)} keys.`,
    );
  }
  return parsed.map((entry: unknown, index) => {
    const { id, sha256, scopes, agent } = (entry ?? {}) as Record<
      string,
      unknown
    >;
    if (typeof id !== "string" || typeof sha256 !== "string") {
      throw new TypeError(
        `GATEWAY_API_KEYS[${String(index)}] needs string id and sha256.`,
      );
    }
    if (
      scopes !== undefined &&
      (!Array.isArray(scopes) || scopes.some((s) => typeof s !== "string"))
    ) {
      throw new TypeError(
        `GATEWAY_API_KEYS[${String(index)}].scopes must be strings.`,
      );
    }
    if (agent !== undefined && typeof agent !== "boolean") {
      throw new TypeError(
        `GATEWAY_API_KEYS[${String(index)}].agent must be a boolean.`,
      );
    }
    return {
      id,
      sha256,
      attributes: {
        scopes: (scopes as string[] | undefined) ?? [],
        ...(agent === undefined ? {} : { agent }),
      },
    };
  });
}

export interface JwtSettings {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUrl: string;
}

/** Reads the optional JWT settings; all three variables or none. */
export function readJwtSettings(
  environment: Readonly<Record<string, string | undefined>>,
): JwtSettings | undefined {
  const issuer = environment.GATEWAY_JWT_ISSUER;
  const audience = environment.GATEWAY_JWT_AUDIENCE;
  const jwksUrl = environment.GATEWAY_JWT_JWKS_URL;
  const configured = [issuer, audience, jwksUrl].filter(
    (value) => value !== undefined && value !== "",
  );
  if (configured.length === 0) return undefined;
  if (configured.length !== 3) {
    throw new TypeError(
      "Set GATEWAY_JWT_ISSUER, GATEWAY_JWT_AUDIENCE, and GATEWAY_JWT_JWKS_URL together.",
    );
  }
  return {
    issuer: issuer as string,
    audience: audience as string,
    jwksUrl: jwksUrl as string,
  };
}

export interface GatewayAuthenticationOptions {
  readonly apiKeys?: ReadonlyArray<ApiKeyCredential>;
  /** A JWT bearer authenticator, normally built from `readJwtSettings`. */
  readonly jwt?: GatewayAuthenticator;
}

/**
 * The gateway accepts people with a JWT from the identity provider and
 * automations with an API key. The chain tries the JWT first; a method that
 * cannot complete, such as an unreachable key set, fails the request instead
 * of falling back to the next method.
 */
export function createGatewayAuthenticator(
  options: GatewayAuthenticationOptions,
): GatewayAuthenticator {
  const methods: GatewayAuthenticator[] = [];
  if (options.jwt !== undefined) methods.push(options.jwt);
  if (options.apiKeys !== undefined) {
    methods.push(apiKeyAuthenticator({ keys: options.apiKeys }));
  }
  if (methods.length === 0) {
    throw new TypeError(
      "Configure GATEWAY_API_KEYS, the GATEWAY_JWT_* variables, or both.",
    );
  }
  return chainAuthenticators(...methods);
}

/** The JWT method for one issuer, with the default claim mapping. */
export function createJwtMethod(settings: JwtSettings): GatewayAuthenticator {
  return createJwtBearerAuthenticator({
    issuer: settings.issuer,
    audience: settings.audience,
    algorithms: ["RS256", "ES256"],
    jwksUrl: settings.jwksUrl,
  });
}
