import { createEngine } from "@invokta/core";

import { whoami } from "./capabilities/whoami.js";

export function createAuthjsEngine() {
  return createEngine({
    name: "auth-authjs-engine",
    version: "0.1.0",
    capabilities: {
      "identity.whoami": whoami,
    },
  });
}

export type AuthjsEngine = ReturnType<typeof createAuthjsEngine>;

export const engine = createAuthjsEngine();
