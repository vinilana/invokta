import type { Principal } from "@ai-engine/core";

import type { KnowledgeArticle } from "../domain/knowledge.js";
import type { Ticket, TicketClassification } from "../domain/ticket.js";

export type CommunityPermission =
  | "ticket:read"
  | "ticket:classify"
  | "ticket:draft-reply"
  | "knowledge:search";

export interface TicketRepository {
  findById(ticketId: string): Promise<Ticket | null>;
}

export interface TicketClassifier {
  classify(
    ticket: Ticket,
    options: { readonly signal: AbortSignal },
  ): Promise<TicketClassification>;
}

export interface KnowledgeBase {
  search(
    query: string,
    options: { readonly signal: AbortSignal },
  ): Promise<ReadonlyArray<KnowledgeArticle>>;
}

export interface PermissionChecker {
  can(
    principal: Principal,
    permission: CommunityPermission,
    resourceId: string,
  ): boolean | Promise<boolean>;
}

/**
 * Every published factory takes exactly the ports it uses, so an importing
 * engine only has to implement what it actually mounts.
 */
export interface TicketAccessDependencies {
  readonly tickets: TicketRepository;
  readonly permissions: PermissionChecker;
}

export interface ClassifyTicketDependencies extends TicketAccessDependencies {
  readonly classifier: TicketClassifier;
}

export interface CommunityLibraryDependencies extends TicketAccessDependencies {
  readonly knowledge: KnowledgeBase;
}

export interface CommunitySupportDependencies
  extends ClassifyTicketDependencies,
    CommunityLibraryDependencies {}
