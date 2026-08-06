import type { Principal } from "@invokta/core";

/**
 * The verified Supabase Auth claims this engine is willing to trust.
 *
 * Supabase access tokens carry many more claims (`aal`, `amr`, `phone`,
 * `app_metadata`, `user_metadata`, ...). Only the values an access rule may
 * legitimately use are mapped here; the token itself never leaves the
 * verifier.
 */
export interface SupabaseIdentity {
  /** The `sub` claim: the Supabase user id. */
  readonly subject: string;
  /** The `role` claim, normally "authenticated". */
  readonly role: string | null;
  /** The `email` claim, when the user has one. */
  readonly email: string | null;
  /** The `session_id` claim: the Supabase Auth session this token belongs to. */
  readonly sessionId: string | null;
  /**
   * The `is_anonymous` claim. Supabase anonymous sign-ins produce tokens with
   * `aud: "authenticated"` and `role: "authenticated"`, so this claim is the
   * only way an access rule can tell an anonymous session apart.
   */
  readonly isAnonymous: boolean | null;
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Maps verified claims to the identity. Returns null when the token has no
 * usable subject, so an unusable claim set fails closed as an invalid
 * credential instead of producing an anonymous principal.
 */
export function toSupabaseIdentity(
  claims: Readonly<Record<string, unknown>>,
): SupabaseIdentity | null {
  const subject = readString(claims.sub);
  if (subject === null) return null;

  return {
    subject,
    role: readString(claims.role),
    email: readString(claims.email),
    sessionId: readString(claims.session_id),
    isAnonymous:
      typeof claims.is_anonymous === "boolean" ? claims.is_anonymous : null,
  };
}

/**
 * Maps the identity to the framework principal. The result is a plain,
 * structured-cloneable object: no token, no claim dump, no SDK instance.
 */
export function toSupabasePrincipal(identity: SupabaseIdentity): Principal {
  return {
    id: identity.subject,
    attributes: {
      ...(identity.role === null ? {} : { role: identity.role }),
      ...(identity.email === null ? {} : { email: identity.email }),
      ...(identity.sessionId === null ? {} : { sessionId: identity.sessionId }),
      ...(identity.isAnonymous === null
        ? {}
        : { isAnonymous: identity.isAnonymous }),
    },
  };
}
