import type { Principal } from "@invokta/core";

/**
 * Auth.js claims and sessions mapped to the framework's minimal `Principal`.
 *
 * Only verified, authorization-relevant fields are copied. The session cookie,
 * the app-issued access token, and any Auth.js or provider object stay at the
 * composition root and never reach a capability.
 */

/**
 * The part of an Auth.js `Session` this example reads.
 *
 * It is declared structurally so the example compiles without depending on
 * `next-auth`. The real `Session` returned by `auth()` is assignable to it.
 */
export interface AuthjsSessionUser {
  readonly id?: string | undefined;
  readonly name?: string | null | undefined;
  readonly email?: string | null | undefined;
  readonly image?: string | null | undefined;
}

export interface AuthjsSession {
  readonly user?: AuthjsSessionUser | undefined;
  /** ISO 8601 timestamp; Auth.js always sets it on a resolved session. */
  readonly expires?: string | undefined;
}

/** The claims this engine trusts after verifying an app-issued access token. */
export interface VerifiedEngineAccessToken {
  readonly subject: string;
  readonly email: string | null;
  readonly name: string | null;
  readonly scopes: ReadonlyArray<string>;
}

/** Identifies which trusted surface established the principal. */
export type IdentityChannel = "authjs-session" | "engine-access-token";

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * The expiry must be present, parse, and still be in the future. Auth.js
 * always sets `expires` on a real session, so requiring it costs nothing
 * there — and a hand-built or partially deserialized session object without
 * an expiry bound fails closed instead of becoming a permanent identity.
 */
function isUnexpired(expires: string | undefined): boolean {
  if (expires === undefined) return false;
  const expiresAt = Date.parse(expires);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

/**
 * Maps a session already resolved by the host's `auth()` call to a principal.
 *
 * Returns `null` for any session that does not prove a usable identity, so the
 * embedded surface fails closed exactly like the HTTP hook does.
 */
export function sessionToPrincipal(
  session: AuthjsSession | null | undefined,
): Principal | null {
  if (session === null || session === undefined) return null;
  if (!isUnexpired(session.expires)) return null;

  const user = session.user;
  if (user === null || user === undefined) return null;

  const id = nonEmptyString(user.id);
  if (id === null) return null;

  const attributes: Record<string, unknown> = {
    channel: "authjs-session" satisfies IdentityChannel,
  };
  const email = nonEmptyString(user.email);
  if (email !== null) attributes.email = email;
  const name = nonEmptyString(user.name);
  if (name !== null) attributes.name = name;

  return { id, attributes };
}

/**
 * Maps the verified claims of an app-issued access token to a principal.
 *
 * The subject is the same Auth.js user id the embedded surface uses, so a
 * caller keeps one identity across both surfaces.
 */
export function accessTokenToPrincipal(
  token: VerifiedEngineAccessToken,
): Principal {
  const attributes: Record<string, unknown> = {
    channel: "engine-access-token" satisfies IdentityChannel,
    scopes: [...token.scopes],
  };
  if (token.email !== null) attributes.email = token.email;
  if (token.name !== null) attributes.name = token.name;

  return { id: token.subject, attributes };
}
