export interface Ticket {
  readonly id: string;
  readonly subject: string;
  readonly body: string;
}

export type TicketCategory = "billing" | "technical" | "commercial" | "other";

export interface TicketClassification {
  readonly category: TicketCategory;
  readonly confidence: number;
  readonly rationale: string;
}
