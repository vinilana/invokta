import { defineCapability, EngineError } from "@invokta/core";
import { z } from "zod";

import type { TicketAccessDependencies } from "../application/ports.js";

const input = z.object({
  ticketId: z.string().trim().min(1),
});

const output = z.object({
  summary: z.string().min(1),
  wordCount: z.number().int().min(1),
});

function firstSentence(body: string): string {
  const [sentence] = body.split(".");
  return sentence === undefined ? body : `${sentence.trim()}.`;
}

export function createSummarizeThread({
  tickets,
  permissions,
}: TicketAccessDependencies) {
  return defineCapability({
    title: "Summarize thread",
    description: "Summarize a support ticket thread in one sentence.",
    input,
    output,
    access: async ({ principal, input: authorizedInput }) => {
      if (principal === null) return false;
      return permissions.can(
        principal,
        "ticket:read",
        authorizedInput.ticketId,
      );
    },
    timeoutMs: 15_000,
    annotations: {
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: false,
    },
    async run({ input: executionInput }) {
      const ticket = await tickets.findById(executionInput.ticketId);
      if (ticket === null) {
        throw new EngineError({
          code: "EXECUTION_FAILED",
          message: "Ticket not found.",
          publicDetails: { ticketId: executionInput.ticketId },
        });
      }
      return {
        summary: `${ticket.subject}: ${firstSentence(ticket.body)}`,
        wordCount: ticket.body.split(/\s+/u).filter((word) => word !== "")
          .length,
      };
    },
  });
}
