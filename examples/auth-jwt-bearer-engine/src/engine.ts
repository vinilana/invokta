import { createEngine } from "@invokta/core";

import { whoami } from "./capabilities/whoami.js";

/**
 * The engine knows nothing about JWTs, JWKS, or the identity provider. It only
 * receives the `Principal` an adapter supplies and applies capability access
 * rules to it.
 */
export function createAuthJwtBearerEngine() {
  return createEngine({
    name: "auth-jwt-bearer-engine",
    version: "0.1.0",
    capabilities: {
      "identity.whoami": whoami,
    },
  });
}

export const engine = createAuthJwtBearerEngine();
