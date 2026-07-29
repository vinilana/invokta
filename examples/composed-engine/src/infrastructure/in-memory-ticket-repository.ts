import type {
  Ticket,
  TicketRepository,
} from "@invokta/example-community-capabilities";

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
