import type { Principal } from "@ai-engine/core";

export const localPrincipal: Principal = Object.freeze({
  id: "local:agent-session-coordinator",
  attributes: Object.freeze({
    permissions: Object.freeze([
      "agent-session:read",
      "agent-session:write",
      "agent-session:hooks",
    ]),
  }),
});

export const hookPrincipal: Principal = Object.freeze({
  id: "local:agent-session-hook",
  attributes: Object.freeze({
    permissions: Object.freeze(["agent-session:hooks"]),
  }),
});
