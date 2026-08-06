import { createEngine } from "@invokta/core";

import { whoami } from "./capabilities/whoami.js";

export function createApiKeyEngine() {
  return createEngine({
    name: "auth-api-key-engine",
    version: "0.1.0",
    capabilities: {
      "identity.whoami": whoami,
    },
  });
}

export const engine = createApiKeyEngine();
