import { defineExportedCapability } from "@ai-engine/core";

import type { TicketAccessDependencies } from "./application/ports.js";
import { createScoreTicketPriority } from "./capabilities/score-ticket-priority.js";

export type {
  ClassifyTicketDependencies,
  CommunityLibraryDependencies,
  CommunityPermission,
  CommunitySupportDependencies,
  KnowledgeBase,
  PermissionChecker,
  TicketAccessDependencies,
  TicketClassifier,
  TicketRepository,
} from "./application/ports.js";
export type { KnowledgeArticle } from "./domain/knowledge.js";
export type {
  Ticket,
  TicketCategory,
  TicketClassification,
  TicketPriority,
} from "./domain/ticket.js";

/**
 * The package root publishes one atomic capability. Dependencies arrive through
 * this factory, never through `ExecutionContext` or a global, so the importing
 * engine keeps ownership of every outbound port.
 */
export function createScoreTicketPriorityExport(
  dependencies: TicketAccessDependencies,
) {
  return defineExportedCapability({
    source: {
      name: "@ai-engine/example-community-capabilities",
      version: "1.4.0",
    },
    defaultId: "community.score-ticket-priority",
    capability: createScoreTicketPriority(dependencies),
  });
}
