import type { Principal } from "@invokta/core";

/**
 * The Better Auth claims this example trusts after verification.
 *
 * Better Auth's JWT plugin puts the whole user object in the token payload
 * unless the application narrows it with `jwt.definePayload`. This example
 * never consumes the payload wholesale: it enumerates the few claims the
 * engine authorizes on, so a later Better Auth plugin or database column
 * cannot silently widen the principal.
 */
export interface BetterAuthClaims {
  /** The `sub` claim, which Better Auth fills with the user id. */
  readonly subject: string;
  readonly email?: string;
  readonly emailVerified?: boolean;
  readonly name?: string;
  /** Present when the admin plugin adds a role to the payload. */
  readonly role?: string;
  /** Present when the organization plugin adds the active organization. */
  readonly activeOrganizationId?: string;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Narrows a verified JWT payload to the enumerated claim set. Returns `null`
 * when the token carries no usable subject, because a principal must have a
 * non-empty string id.
 */
export function readBetterAuthClaims(
  payload: Readonly<Record<string, unknown>>,
): BetterAuthClaims | null {
  const subject = readString(payload.sub);
  if (subject === undefined) return null;

  const email = readString(payload.email);
  const emailVerified = readBoolean(payload.emailVerified);
  const name = readString(payload.name);
  const role = readString(payload.role);
  const activeOrganizationId = readString(payload.activeOrganizationId);

  return {
    subject,
    ...(email === undefined ? {} : { email }),
    ...(emailVerified === undefined ? {} : { emailVerified }),
    ...(name === undefined ? {} : { name }),
    ...(role === undefined ? {} : { role }),
    ...(activeOrganizationId === undefined ? {} : { activeOrganizationId }),
  };
}

/**
 * Maps verified claims to the framework's minimal principal. The raw token,
 * the full Better Auth payload, and any live SDK object stay at this boundary.
 */
export function toPrincipal(claims: BetterAuthClaims): Principal {
  const { subject, ...attributes } = claims;
  return Object.freeze({
    id: subject,
    attributes: Object.freeze({ ...attributes }),
  });
}
