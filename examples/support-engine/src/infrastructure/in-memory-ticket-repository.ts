import type { TicketRepository } from "../application/ports.js";
import type { Ticket } from "../domain/ticket.js";

export function createInMemoryTicketRepository(
  tickets: ReadonlyArray<Ticket>,
): TicketRepository {
  const ticketsById = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  return {
    async findById(ticketId) {
      return ticketsById.get(ticketId) ?? null;
    },
  };
}
