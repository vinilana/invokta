import { CapabilityError, createEngine, defineCapability } from "@invokta/core";
import { z } from "zod";

/**
 * The support team's Action Engine. It runs in the gateway process and keeps
 * its own access rules: closing a ticket requires an agent, whatever the
 * gateway allows.
 */
export function createSupportEngine() {
  const closed = new Set<string>();

  return createEngine({
    name: "support-engine",
    version: "1.0.0",
    capabilities: {
      "support.classify-ticket": defineCapability({
        title: "Classify ticket",
        description:
          "Classify a support ticket into billing, access, or general from its subject.",
        input: z.object({
          ticketId: z.string().min(1),
          subject: z.string().min(1).max(500),
        }),
        output: z.object({
          ticketId: z.string(),
          category: z.enum(["billing", "access", "general"]),
        }),
        access: "authenticated",
        annotations: { readOnly: true },
        async run({ input }) {
          const subject = input.subject.toLowerCase();
          const category = /invoice|refund|charge/u.test(subject)
            ? "billing"
            : /password|login|access/u.test(subject)
              ? "access"
              : "general";
          return { ticketId: input.ticketId, category };
        },
      }),
      "support.close-ticket": defineCapability({
        title: "Close ticket",
        description: "Close a resolved support ticket.",
        input: z.object({ ticketId: z.string().min(1) }),
        output: z.object({ ticketId: z.string(), closed: z.literal(true) }),
        access: ({ principal }) => principal?.attributes?.agent === true,
        annotations: { destructive: true, idempotent: false },
        errors: {
          TICKET_ALREADY_CLOSED: {
            description: "The ticket is already closed.",
            details: z.object({ ticketId: z.string() }),
          },
        },
        async run({ input }) {
          if (closed.has(input.ticketId)) {
            throw new CapabilityError("TICKET_ALREADY_CLOSED", {
              details: { ticketId: input.ticketId },
            });
          }
          closed.add(input.ticketId);
          return { ticketId: input.ticketId, closed: true as const };
        },
      }),
    },
  });
}
