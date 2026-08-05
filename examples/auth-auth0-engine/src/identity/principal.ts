import type { Principal } from "@invokta/core";
import type { JWTPayload } from "jose";

/**
 * Auth0 claims to `Principal`.
 *
 * Only verified, authorization-relevant claims cross this boundary:
 *
 * - `sub` becomes `Principal.id`;
 * - `scope`, a space-delimited string, becomes `attributes.scopes`;
 * - `permissions`, present when the API has RBAC with "Add Permissions in the
 *   Access Token" enabled, becomes `attributes.permissions`.
 *
 * The raw token, the full claim set, and provider objects stay at the
 * composition root.
 */
export function toAuth0Principal(claims: JWTPayload): Principal | null {
  const subject = typeof claims.sub === "string" ? claims.sub.trim() : "";
  if (subject === "") return null;

  const attributes: Record<string, unknown> = {
    scopes: readScopes(claims.scope),
  };
  const permissions = readPermissions(claims.permissions);
  if (permissions !== null) attributes.permissions = permissions;

  return { id: subject, attributes };
}

/** Auth0 delivers granted scopes as one space-delimited string. */
function readScopes(scope: unknown): ReadonlyArray<string> {
  if (typeof scope !== "string") return [];
  return [...new Set(scope.split(/\s+/u).filter((value) => value !== ""))];
}

/**
 * Returns the RBAC permissions, or `null` when the claim is absent or is not
 * a list of non-empty strings. A malformed claim is dropped rather than
 * partially trusted: an access rule must never see a half-parsed permission
 * set.
 */
function readPermissions(value: unknown): ReadonlyArray<string> | null {
  if (!Array.isArray(value)) return null;
  const usable = value.filter(
    (item): item is string => typeof item === "string" && item !== "",
  );
  return usable.length === value.length ? [...new Set(usable)] : null;
}
