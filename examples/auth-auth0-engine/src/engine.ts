import { createEngine } from "@invokta/core";

import { whoami } from "./capabilities/whoami.js";

export function createAuth0Engine() {
  return createEngine({
    name: "auth-auth0-engine",
    version: "0.1.0",
    capabilities: {
      "identity.whoami": whoami,
    },
  });
}

export const engine = createAuth0Engine();
