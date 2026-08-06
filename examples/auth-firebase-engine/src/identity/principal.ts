/**
 * Firebase claims to `Principal` mapping.
 *
 * The mapping is deliberately an allowlist. A blanket copy of the decoded token
 * would put unverified, provider-owned, and potentially sensitive fields into
 * capability-visible identity, so every attribute below is named and its value
 * is type-checked at runtime.
 */
import type { Principal } from "@invokta/core";

import type { FirebaseIdTokenClaims } from "./verifier.js";

export interface FirebasePrincipalOptions {
  /** The Firebase project this engine accepts tokens for. */
  readonly projectId: string;
  /**
   * Custom claim names copied into `attributes.customClaims`. Firebase places
   * custom claims at the top level of the token; only these names are read, and
   * only string, finite number, boolean, and string-array values are kept.
   */
  readonly customClaimNames?: ReadonlyArray<string>;
}

/** Firebase signs ID tokens with this issuer for a given project. */
export function firebaseIssuer(projectId: string): string {
  return `https://securetoken.google.com/${projectId}`;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function readMember(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[name]
    : undefined;
}

function readCustomClaimValue(value: unknown): unknown {
  if (typeof value === "string") return value === "" ? undefined : value;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    return Number.isFinite(value) && !Object.is(value, -0) ? value : undefined;
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return [...value];
  }
  return undefined;
}

/**
 * Converts verified claims into a principal, or returns `null` when the claims
 * are not usable as an identity for this engine.
 *
 * Issuer and audience are re-checked here even though the verifier already
 * validated them. It is a cheap, local guarantee that a token minted for
 * another Firebase project can never become a principal of this engine.
 */
export function toPrincipal(
  claims: FirebaseIdTokenClaims,
  options: FirebasePrincipalOptions,
): Principal | null {
  if (claims.iss !== firebaseIssuer(options.projectId)) return null;
  if (claims.aud !== options.projectId) return null;

  const uid = readNonEmptyString(claims.sub) ?? readNonEmptyString(claims.uid);
  if (uid === null) return null;

  const attributes: Record<string, unknown> = {};

  const email = readNonEmptyString(claims.email);
  if (email !== null) attributes.email = email;
  if (typeof claims.email_verified === "boolean") {
    attributes.emailVerified = claims.email_verified;
  }
  if (
    typeof claims.auth_time === "number" &&
    Number.isFinite(claims.auth_time)
  ) {
    attributes.authTime = claims.auth_time;
  }
  const signInProvider = readNonEmptyString(
    readMember(claims.firebase, "sign_in_provider"),
  );
  if (signInProvider !== null) attributes.signInProvider = signInProvider;
  const tenantId = readNonEmptyString(readMember(claims.firebase, "tenant"));
  if (tenantId !== null) attributes.tenantId = tenantId;

  const customClaims: Record<string, unknown> = {};
  for (const name of options.customClaimNames ?? []) {
    const value = readCustomClaimValue(claims[name]);
    if (value !== undefined) customClaims[name] = value;
  }
  if (Object.keys(customClaims).length > 0) {
    attributes.customClaims = customClaims;
  }

  return { id: uid, attributes };
}
