import { createEngine } from "@invokta/core";

import { whoami } from "./capabilities/whoami.js";

export const engine = createEngine({
  name: "auth-cognito-engine",
  version: "0.1.0",
  capabilities: {
    "identity.whoami": whoami,
  },
});
