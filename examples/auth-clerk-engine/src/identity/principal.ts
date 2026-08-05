import type { Principal } from "@invokta/core";

import type { ClerkSessionClaims } from "./verifier.js";

/**
 * Maps verified Clerk session claims to the framework's minimal `Principal`.
 *
 * Only claims an access rule can reasonably decide on are carried: the Clerk
 * user ID becomes the principal ID, and the session and active-organization
 * claims become attributes when the session has them. The token, its raw claim
 * set, and any SDK object stay at the composition root.
 */
export function toPrincipal(claims: ClerkSessionClaims): Principal {
  const attributes: Record<string, unknown> = {};
  if (claims.sid !== undefined) attributes.sessionId = claims.sid;
  if (claims.org_id !== undefined) attributes.organizationId = claims.org_id;
  if (claims.org_role !== undefined) {
    attributes.organizationRole = claims.org_role;
  }

  return Object.freeze({
    id: claims.sub,
    attributes: Object.freeze(attributes),
  });
}
