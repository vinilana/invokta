import type { Principal } from "@ai-engine/core";

/** Trusted identity supplied by the local CLI and MCP stdio hosts. */
export const localPrincipal: Principal = Object.freeze({
  id: "local:image-operator",
});
