import type { Principal } from "@invokta/core";

/** Trusted identity supplied by the local direct, CLI, and MCP stdio hosts. */
export const localPrincipal: Principal = Object.freeze({
  id: "local:obsidian-context-reader",
});
