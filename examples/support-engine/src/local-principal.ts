import type { Principal } from "@ai-engine/core";

export const localPrincipal: Principal = Object.freeze({
  id: "local:support-operator",
  attributes: Object.freeze({
    permissions: Object.freeze(["ticket:classify"]),
    allowedTicketIds: Object.freeze(["T-123", "T-456"]),
  }),
});
