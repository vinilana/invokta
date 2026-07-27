import { createEngine } from "@ai-engine/core";

import type { SupportDependencies } from "./application/ports.js";
import { createClassifyTicket } from "./capabilities/classify-ticket.js";
import { createAttributePermissionChecker } from "./infrastructure/attribute-permission-checker.js";
import { createInMemoryTicketRepository } from "./infrastructure/in-memory-ticket-repository.js";
import { createRuleBasedTicketClassifier } from "./infrastructure/rule-based-ticket-classifier.js";

export function createSupportEngine(dependencies: SupportDependencies) {
  return createEngine({
    name: "support-engine",
    version: "0.1.0",
    capabilities: {
      "support.classify-ticket": createClassifyTicket(dependencies),
    },
  });
}

export function createDefaultSupportEngine() {
  return createSupportEngine({
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
    ]),
    classifier: createRuleBasedTicketClassifier(),
    permissions: createAttributePermissionChecker(),
  });
}

export const engine = createDefaultSupportEngine();
