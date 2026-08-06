import type { Principal } from "@invokta/core";

import type { WorkOsAccessTokenClaims } from "./verifier.js";

/**
 * Maps verified WorkOS AuthKit claims to the framework principal.
 *
 * The claim names are kept verbatim so the mapping stays checkable against the
 * WorkOS documentation: `sub` becomes the principal id, and `org_id`, `role`,
 * `permissions`, and `sid` become attributes when the token carries them.
 * `org_id` is the multi-tenant attribute a capability access rule keys on.
 *
 * Nothing else is copied: no raw token, no full claim set, and no SDK object.
 */
export function toPrincipal(claims: WorkOsAccessTokenClaims): Principal {
  const attributes = {
    ...(claims.sid === undefined ? {} : { sid: claims.sid }),
    ...(claims.org_id === undefined ? {} : { org_id: claims.org_id }),
    ...(claims.role === undefined ? {} : { role: claims.role }),
    ...(claims.permissions === undefined
      ? {}
      : { permissions: Object.freeze([...claims.permissions]) }),
  };

  return Object.keys(attributes).length === 0
    ? Object.freeze({ id: claims.sub })
    : Object.freeze({ id: claims.sub, attributes: Object.freeze(attributes) });
}
