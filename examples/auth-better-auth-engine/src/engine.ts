import { createEngine } from "@invokta/core";

import { whoami } from "./capabilities/whoami.js";

export function createBetterAuthEngine() {
  return createEngine({
    name: "auth-better-auth-engine",
    version: "0.1.0",
    capabilities: {
      "identity.whoami": whoami,
    },
  });
}

export const engine = createBetterAuthEngine();
