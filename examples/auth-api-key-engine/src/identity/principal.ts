import type { Principal } from "@invokta/core";

import type { VerifiedApiKey } from "./verifier.js";

/**
 * Maps a verified key to the framework's minimal principal.
 *
 * Only verified, authorization-relevant values are copied: the service the key
 * belongs to, the key id that proved it, and the scopes the deployment granted
 * that key. The credential, its digest, and the registry record never appear.
 */
export function toPrincipal(identity: VerifiedApiKey): Principal {
  return Object.freeze({
    id: identity.serviceName,
    attributes: Object.freeze({
      keyId: identity.keyId,
      scopes: Object.freeze([...identity.scopes]),
    }),
  });
}
