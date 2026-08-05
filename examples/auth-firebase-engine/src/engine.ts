import { createEngine } from "@invokta/core";

import { whoami } from "./capabilities/whoami.js";

export function createFirebaseAuthEngine() {
  return createEngine({
    name: "auth-firebase-engine",
    version: "0.1.0",
    capabilities: {
      "identity.whoami": whoami,
    },
  });
}

export const engine = createFirebaseAuthEngine();
