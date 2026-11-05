import {
  createJwtBearerAuthenticator,
  type JwtBearerAuthenticator,
  type JwtKeySource,
} from "@invokta/auth-jwt";

import { toAuth0Principal } from "./principal.js";

/**
 * Auth0 access token authentication for a registered API.
 *
 * Auth0 mints the `iss` claim as the tenant origin with a trailing slash
 * (`https://<tenant-domain>/`) and publishes its signing keys at
 * `https://<tenant-domain>/.well-known/jwks.json`. An access token for a
 * registered API carries that API's identifier in `aud`, so the audience check
 * is required: without it a token minted for another API of the same tenant,
 * or for the tenant's own `/userinfo` endpoint, would be accepted here.
 *
 * `@invokta/auth-jwt` performs the bearer parsing, signature, algorithm,
 * issuer, audience, and lifetime checks and keeps an unreachable tenant
 * distinct from an invalid credential. This module owns only what is specific
 * to Auth0: the issuer and key-set derivation, RS256, and the claim mapping.
 */

const defaultClockToleranceSeconds = 5;

export interface Auth0AuthenticatorOptions {
  /** Tenant or custom domain, with or without the `https://` prefix. */
  readonly domain: string;
  /** The API identifier configured in Auth0, matched against `aud`. */
  readonly audience: string;
  /**
   * Key source. Production wiring omits it and gets the tenant's remote JWKS;
   * tests pass a local key set so signature verification stays real and
   * offline.
   */
  readonly keySource?: JwtKeySource;
  readonly clockToleranceSeconds?: number;
}

/** Returns the exact `iss` value Auth0 puts in the tenant's tokens. */
export function auth0Issuer(domain: string): string {
  const trimmed = domain.trim();
  if (trimmed === "") {
    throw new TypeError("An Auth0 domain is required.");
  }
  let url: URL;
  try {
    url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    throw new TypeError("The Auth0 domain is not a valid origin.");
  }
  if (url.protocol !== "https:") {
    throw new TypeError("The Auth0 domain must use HTTPS.");
  }
  // The trailing slash is part of the claim, not a formatting choice.
  return `${url.origin}/`;
}

/** Returns the tenant's JWKS document URL, derived from the issuer. */
export function auth0JwksUri(domain: string): URL {
  return new URL(".well-known/jwks.json", auth0Issuer(domain));
}

/**
 * Builds the `auth.authenticate` hook: `Principal` for a verified Auth0 access
 * token, `null` for every invalid or missing credential, and a rejection only
 * when the check itself could not run.
 */
export function createAuth0Authenticator(
  options: Auth0AuthenticatorOptions,
): JwtBearerAuthenticator {
  const audience = options.audience.trim();
  if (audience === "") {
    throw new TypeError("An Auth0 API identifier is required as the audience.");
  }
  return createJwtBearerAuthenticator({
    issuer: auth0Issuer(options.domain),
    audience,
    // Auth0 signs API access tokens with RS256.
    algorithms: ["RS256"],
    clockToleranceSeconds:
      options.clockToleranceSeconds ?? defaultClockToleranceSeconds,
    principal: toAuth0Principal,
    ...(options.keySource ?? { jwksUrl: auth0JwksUri(options.domain) }),
  });
}
