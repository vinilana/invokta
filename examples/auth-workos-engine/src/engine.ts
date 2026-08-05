import { createEngine } from "@invokta/core";

import { whoami } from "./capabilities/whoami.js";

export function createAuthWorkOsEngine() {
  return createEngine({
    name: "auth-workos-engine",
    version: "0.1.0",
    capabilities: {
      "identity.whoami": whoami,
    },
  });
}

export const engine = createAuthWorkOsEngine();
