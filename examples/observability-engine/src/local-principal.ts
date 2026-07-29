import type { Principal } from "@ai-engine/core";

/** Trusted identity supplied by local direct, CLI, and MCP stdio hosts. */
export const localPrincipal: Principal = Object.freeze({
  id: "local:observability-operator",
});
