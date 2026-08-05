import { createEngine } from "@invokta/core";

import { whoami } from "./capabilities/whoami.js";

export function createAuthClerkEngine() {
  return createEngine({
    name: "auth-clerk-engine",
    version: "0.1.0",
    capabilities: {
      "identity.whoami": whoami,
    },
  });
}

export const engine = createAuthClerkEngine();
