import { createEngine } from "@invokta/core";

import { whoAmI } from "./capabilities/whoami.js";

export function createSelfHostedOAuthEngine() {
  return createEngine({
    name: "auth-self-hosted-oauth-engine",
    version: "0.1.0",
    capabilities: {
      "identity.whoami": whoAmI,
    },
  });
}

export const engine = createSelfHostedOAuthEngine();
