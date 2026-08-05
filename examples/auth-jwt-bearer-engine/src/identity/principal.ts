import type { Principal } from "@invokta/core";

/**
 * A verified JWT claim set. The verifier hands the payload to this module only
 * after signature, issuer, audience, and expiry checks have passed, so every
 * value read here is trusted. Nothing else in the example sees a claim set.
 */
export type VerifiedAccessTokenClaims = Readonly<Record<string, unknown>>;

/**
 * The enumerated claims this example is willing to place in `Principal`.
 * Adding a claim is a deliberate act: an access rule can read it, so it must
 * be verified and authorization-relevant. A raw token, a full claim dump, or a
 * provider SDK object never belongs here.
 */
export interface JwtPrincipalAttributes {
  /** The `scope` claim, split into its individual values. */
  readonly scopes: ReadonlyArray<string>;
  /** The verified `iss` claim, so multi-issuer rules can tell tenants apart. */
  readonly issuer: string;
  /** The OAuth client that requested the token, when the issuer sets it. */
  readonly clientId?: string;
}

/**
 * Splits an OAuth `scope` claim into its values.
 *
 * RFC 6749 defines `scope` as a space-delimited string, and RFC 9068 keeps that
 * form for JWT access tokens. Any other shape is treated as "no scopes" rather
 * than guessed at, so a malformed claim can never widen authority.
 */
export function parseScopeClaim(value: unknown): ReadonlyArray<string> {
  if (typeof value !== "string") return Object.freeze([]);
  const scopes = value.split(/\s+/u).filter((scope) => scope !== "");
  return Object.freeze([...new Set(scopes)]);
}

/**
 * Maps a verified claim set to the framework's minimal `Principal`.
 *
 * Returns `null` when the claim set cannot identify a subject. The caller turns
 * that into an invalid-credential result, never into an anonymous principal.
 */
export function toPrincipal(
  claims: VerifiedAccessTokenClaims,
): Principal | null {
  const subject = claims.sub;
  if (typeof subject !== "string" || subject.trim() === "") return null;

  const issuer = claims.iss;
  if (typeof issuer !== "string" || issuer === "") return null;

  const clientId = claims.client_id;
  const attributes: JwtPrincipalAttributes = {
    scopes: parseScopeClaim(claims.scope),
    issuer,
    ...(typeof clientId === "string" && clientId !== "" ? { clientId } : {}),
  };

  return Object.freeze({
    id: subject,
    attributes: Object.freeze({ ...attributes }),
  });
}
