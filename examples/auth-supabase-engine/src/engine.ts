import { createEngine } from "@invokta/core";

import { whoami } from "./capabilities/whoami.js";

export function createAuthSupabaseEngine() {
  return createEngine({
    name: "auth-supabase-engine",
    version: "0.1.0",
    capabilities: {
      "identity.whoami": whoami,
    },
  });
}

export const engine = createAuthSupabaseEngine();
