import type { Principal } from "@invokta/core";

export const localPrincipal: Principal = Object.freeze({
  id: "local:support-operator",
  attributes: Object.freeze({
    permissions: Object.freeze(["ticket:classify"]),
    // T-404 is allowed but absent from the in-memory repository, so it
    // demonstrates the declared TICKET_NOT_FOUND domain error.
    allowedTicketIds: Object.freeze(["T-123", "T-456", "T-404"]),
  }),
});
