import { defineCapability, EngineError } from "@ai-engine/core";
import { z } from "zod";

import type { TicketAccessDependencies } from "../application/ports.js";
import type { TicketPriority } from "../domain/ticket.js";

const input = z.object({
  ticketId: z.string().trim().min(1),
});

const output = z.object({
  priority: z.enum(["low", "normal", "high", "urgent"]),
  weight: z.number().int().min(0),
  signals: z.array(z.string().min(1)),
});

const prioritySignals: ReadonlyArray<readonly [string, number]> = [
  ["outage", 3],
  ["urgent", 2],
  ["blocked", 2],
  ["error", 1],
  ["invoice", 1],
];

function toPriority(weight: number): TicketPriority {
  if (weight >= 4) return "urgent";
  if (weight >= 2) return "high";
  return weight >= 1 ? "normal" : "low";
}

export function createScoreTicketPriority({
  tickets,
  permissions,
}: TicketAccessDependencies) {
  return defineCapability({
    title: "Score ticket priority",
    description: "Score the operational priority of a support ticket.",
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
    timeoutMs: 10_000,
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
      const text = `${ticket.subject} ${ticket.body}`.toLowerCase();
      const matched = prioritySignals.filter(([term]) => text.includes(term));
      const weight = matched.reduce((total, [, value]) => total + value, 0);
      return {
        priority: toPriority(weight),
        weight,
        signals: matched.map(([term]) => term),
      };
    },
  });
}
