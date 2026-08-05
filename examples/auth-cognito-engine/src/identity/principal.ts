import type { Principal } from "@invokta/core";

import type { CognitoVerifiedIdentity } from "./verifier.js";

/**
 * Maps verified Cognito access-token claims to the framework `Principal`.
 *
 * Only claims an access rule can act on are carried over: the user pool
 * subject, the calling app client, the granted OAuth scopes, and the user's
 * Cognito groups. The token, its header, and every unverified or purely
 * informational claim stay in the composition root.
 */
export function toPrincipal(identity: CognitoVerifiedIdentity): Principal {
  return {
    id: identity.subject,
    attributes: {
      clientId: identity.clientId,
      scopes: [...identity.scopes],
      groups: [...identity.groups],
    },
  };
}
