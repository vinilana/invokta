import { vi } from "vitest";

import type {
  CommunitySupportDependencies,
  KnowledgeBase,
  PermissionChecker,
  TicketClassifier,
  TicketRepository,
} from "../src/application/ports.js";
import type { KnowledgeArticle } from "../src/domain/knowledge.js";
import type { Ticket } from "../src/domain/ticket.js";

const defaultTickets: ReadonlyArray<Ticket> = [
  {
    id: "T-123",
    subject: "Duplicate invoice",
    body: "I was charged twice for the same invoice.",
  },
  {
    id: "T-456",
    subject: "Login error",
    body: "The application reports an error after I sign in.",
  },
];

export function createTicketRepository(
  available: ReadonlyArray<Ticket> = defaultTickets,
): TicketRepository {
  const ticketsById = new Map(available.map((ticket) => [ticket.id, ticket]));
  return {
    findById: vi.fn(
      async (ticketId: string) => ticketsById.get(ticketId) ?? null,
    ),
  };
}

export function createTicketClassifier(): TicketClassifier {
  return {
    classify: vi.fn(async () => ({
      category: "billing" as const,
      confidence: 0.98,
      rationale: "The ticket reports a duplicate charge.",
    })),
  };
}

export function createKnowledgeBase(
  articles: ReadonlyArray<KnowledgeArticle>,
): KnowledgeBase {
  return {
    search: vi.fn(async () => articles),
  };
}

export function createPermissionChecker(allowed = true): PermissionChecker {
  return { can: vi.fn(async () => allowed) };
}

export function createDependencies(
  overrides: Partial<CommunitySupportDependencies> = {},
): CommunitySupportDependencies {
  return {
    tickets: createTicketRepository(),
    classifier: createTicketClassifier(),
    knowledge: createKnowledgeBase([
      {
        id: "KB-1",
        title: "Requesting a duplicate charge refund",
        url: "https://example.invalid/kb/refunds",
      },
    ]),
    permissions: createPermissionChecker(),
    ...overrides,
  };
}
