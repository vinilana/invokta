import type { TicketClassifier } from "../application/ports.js";
import type { TicketCategory } from "../domain/ticket.js";

const categoryTerms: ReadonlyArray<
  readonly [TicketCategory, ReadonlyArray<string>]
> = [
  ["billing", ["bill", "charge", "invoice", "payment", "refund"]],
  ["technical", ["bug", "crash", "error", "failure", "login"]],
  ["commercial", ["demo", "price", "proposal", "quote", "upgrade"]],
];

export function createRuleBasedTicketClassifier(): TicketClassifier {
  return {
    async classify(ticket, { signal }) {
      signal.throwIfAborted();
      const text = `${ticket.subject} ${ticket.body}`.toLowerCase();
      const matched = categoryTerms.find(([, terms]) =>
        terms.some((term) => text.includes(term)),
      );
      const category = matched?.[0] ?? "other";
      return {
        category,
        confidence: matched === undefined ? 0.55 : 0.9,
        rationale:
          matched === undefined
            ? "No category-specific term was found."
            : `The ticket contains language associated with ${category}.`,
      };
    },
  };
}
