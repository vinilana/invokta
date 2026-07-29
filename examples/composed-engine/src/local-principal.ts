import type { Principal } from "@invokta/core";

export const localPrincipal: Principal = Object.freeze({
  id: "local:operations-analyst",
  attributes: Object.freeze({
    permissions: Object.freeze([
      "ticket:read",
      "ticket:classify",
      "ticket:draft-reply",
      "knowledge:search",
    ]),
    allowedTicketIds: Object.freeze(["T-123", "T-456", "T-789"]),
  }),
});
