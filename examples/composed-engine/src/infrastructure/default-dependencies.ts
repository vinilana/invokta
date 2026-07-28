import type { OperationsDependencies } from "../application/ports.js";
import { createAttributePermissionChecker } from "./attribute-permission-checker.js";
import { createInMemoryKnowledgeBase } from "./in-memory-knowledge-base.js";
import { createInMemoryTicketRepository } from "./in-memory-ticket-repository.js";
import { createRuleBasedTicketClassifier } from "./rule-based-ticket-classifier.js";
import { createStaticReportSource } from "./static-report-source.js";

export function createDefaultOperationsDependencies(): OperationsDependencies {
  return {
    community: {
      tickets: createInMemoryTicketRepository([
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
        {
          id: "T-789",
          subject: "Urgent outage",
          body: "The production API is blocked and returns an error.",
        },
      ]),
      classifier: createRuleBasedTicketClassifier(),
      knowledge: createInMemoryKnowledgeBase([
        {
          id: "KB-1",
          title: "Requesting a duplicate charge refund",
          url: "https://example.invalid/kb/refunds",
        },
        {
          id: "KB-2",
          title: "Resetting a blocked login",
          url: "https://example.invalid/kb/login",
        },
        {
          id: "KB-3",
          title: "Reading an invoice",
          url: "https://example.invalid/kb/invoices",
        },
      ]),
      permissions: createAttributePermissionChecker(),
    },
    reports: createStaticReportSource([
      {
        day: "2026-07-27",
        openTickets: 3,
        resolvedTickets: 11,
        headline: "Billing questions dominated the queue.",
      },
    ]),
  };
}
