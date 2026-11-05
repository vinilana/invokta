/**
 * Where an issuer publishes its signing keys.
 *
 * `@invokta/auth-jwt` takes an explicit key-set URL and holds it to the
 * HTTPS-or-loopback rule. Deriving that URL from the issuer is deployment
 * configuration, so it stays in the example.
 */

function isLoopbackHttp(url: URL): boolean {
  return (
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" ||
      url.hostname === "localhost" ||
      url.hostname === "[::1]")
  );
}

/**
 * Normalizes an issuer identifier and rejects one this example cannot use.
 *
 * OpenID Connect Discovery requires a terminating `/` to be removed before a
 * well-known suffix is appended, so the same normalization backs every derived
 * URL below.
 */
function normalizeIssuer(issuer: string): string {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new TypeError("The issuer must be an absolute HTTPS URL.");
  }

  if (url.protocol !== "https:" && !isLoopbackHttp(url)) {
    throw new TypeError(
      "The issuer must use HTTPS, except for loopback development.",
    );
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError(
      "The issuer must not contain credentials, a query, or a fragment.",
    );
  }

  return url.href.endsWith("/") ? url.href.slice(0, -1) : url.href;
}

/**
 * The OpenID Provider configuration URL for an issuer. Its `jwks_uri` member is
 * the authoritative key-set location; fetch it once at deployment time and pass
 * the result as the JWKS override rather than trusting the convention below.
 */
export function openIdConfigurationUrl(issuer: string): string {
  return `${normalizeIssuer(issuer)}/.well-known/openid-configuration`;
}

/**
 * The JWKS location most OIDC providers publish. This is a widespread
 * convention, not a specification requirement: `jwks_uri` in the discovery
 * document is normative, and several providers host their key set elsewhere.
 */
export function conventionalJwksUri(issuer: string): string {
  return `${normalizeIssuer(issuer)}/.well-known/jwks.json`;
}

/**
 * Uses an explicit JWKS URI when configured, otherwise the convention. The
 * authenticator rejects an override that is not HTTPS or loopback HTTP: keys
 * fetched over plaintext HTTP could be replaced by an on-path attacker, and a
 * substituted key set turns into accepted attacker-minted tokens.
 */
export function resolveJwksUri(issuer: string, override?: string): string {
  if (override !== undefined && override !== "") return override;
  return conventionalJwksUri(issuer);
}
