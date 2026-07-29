import type { Principal } from "@invokta/core";

import type { Ticket, TicketClassification } from "../domain/ticket.js";

export interface TicketRepository {
  findById(ticketId: string): Promise<Ticket | null>;
}

export interface TicketClassifier {
  classify(
    ticket: Ticket,
    options: { readonly signal: AbortSignal },
  ): Promise<TicketClassification>;
}

export interface PermissionChecker {
  can(
    principal: Principal,
    permission: "ticket:classify",
    ticketId: string,
  ): boolean | Promise<boolean>;
}

export interface SupportDependencies {
  readonly tickets: TicketRepository;
  readonly classifier: TicketClassifier;
  readonly permissions: PermissionChecker;
}
