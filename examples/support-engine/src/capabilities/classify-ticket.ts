import { defineCapability, EngineError } from "@invokta/core";
import { z } from "zod";

import type { SupportDependencies } from "../application/ports.js";

const input = z.object({
  ticketId: z.string().trim().min(1),
});

const output = z.object({
  category: z.enum(["billing", "technical", "commercial", "other"]),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1),
});

export function createClassifyTicket({
  tickets,
  classifier,
  permissions,
}: SupportDependencies) {
  return defineCapability({
    title: "Classify ticket",
    description: "Classify a support ticket into an operational category.",
    input,
    output,
    access: async ({ principal, input: authorizedInput }) => {
      if (principal === null) return false;
      return permissions.can(
        principal,
        "ticket:classify",
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
      return classifier.classify(ticket, { signal: context.signal });
    },
  });
}
