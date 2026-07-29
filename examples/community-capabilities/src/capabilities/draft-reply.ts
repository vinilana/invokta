import { defineCapability, EngineError } from "@invokta/core";
import { z } from "zod";

import type { CommunityLibraryDependencies } from "../application/ports.js";

const input = z.object({
  ticketId: z.string().trim().min(1),
  tone: z.enum(["formal", "friendly"]).default("formal"),
});

const output = z.object({
  subject: z.string().min(1),
  body: z.string().min(1),
  citedArticleIds: z.array(z.string().min(1)),
});

export function createDraftReply({
  tickets,
  knowledge,
  permissions,
}: CommunityLibraryDependencies) {
  return defineCapability({
    title: "Draft reply",
    description: "Draft a support reply grounded in knowledge base articles.",
    input,
    output,
    access: async ({ principal, input: authorizedInput }) => {
      if (principal === null) return false;
      return permissions.can(
        principal,
        "ticket:draft-reply",
        authorizedInput.ticketId,
      );
    },
    timeoutMs: 30_000,
    annotations: {
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: false,
    },
    async run({ input: executionInput, context }) {
      const ticket = await tickets.findById(executionInput.ticketId);
      if (ticket === null) {
        throw new EngineError({
          code: "EXECUTION_FAILED",
          message: "Ticket not found.",
          publicDetails: { ticketId: executionInput.ticketId },
        });
      }
      const articles = await knowledge.search(ticket.subject, {
        signal: context.signal,
      });
      const greeting =
        executionInput.tone === "friendly" ? "Hi there," : "Dear customer,";
      const references =
        articles.length === 0
          ? "We are reviewing your report and will follow up shortly."
          : `We recommend these articles: ${articles
              .map((article) => article.title)
              .join(", ")}.`;
      return {
        subject: `Re: ${ticket.subject}`,
        body: `${greeting} ${references}`,
        citedArticleIds: articles.map((article) => article.id),
      };
    },
  });
}
