import { CapabilityError, createEngine, defineCapability } from "@invokta/core";
import { z } from "zod";

/** A support engine whose own access rules stay enforced behind the gateway. */
export function createSupportEngine() {
  return createEngine({
    name: "support-engine",
    version: "1.2.0",
    capabilities: {
      "support.classify-ticket": defineCapability({
        title: "Classify ticket",
        description: "Classify a support ticket into an operational category.",
        input: z.object({ ticketId: z.string().min(1) }),
        output: z.object({ category: z.string(), principalId: z.string() }),
        access: "authenticated",
        annotations: { readOnly: true },
        async run({ input, context }) {
          context.reportProgress({ progress: 1, total: 2 });
          return {
            category: input.ticketId.startsWith("B") ? "billing" : "general",
            principalId: context.principal?.id ?? "anonymous",
          };
        },
      }),
      "support.close-ticket": defineCapability({
        description: "Close a support ticket.",
        input: z.object({ ticketId: z.string() }),
        output: z.object({ closed: z.boolean() }),
        access: ({ principal }) => principal?.attributes?.agent === true,
        errors: {
          TICKET_ALREADY_CLOSED: {
            description: "The ticket is already closed.",
            details: z.object({ ticketId: z.string() }),
          },
        },
        async run({ input }) {
          if (input.ticketId === "T-closed") {
            throw new CapabilityError("TICKET_ALREADY_CLOSED", {
              details: { ticketId: input.ticketId },
            });
          }
          return { closed: true };
        },
      }),
      "support.wait": defineCapability({
        description: "Wait until the invocation is cancelled.",
        input: z.object({}),
        output: z.object({}),
        access: "public",
        async run({ context }) {
          return new Promise((_resolve, reject) => {
            context.signal.addEventListener(
              "abort",
              () => reject(context.signal.reason),
              { once: true },
            );
          });
        },
      }),
    },
  });
}

/** A billing engine used to prove that two engines aggregate side by side. */
export function createBillingEngine() {
  return createEngine({
    name: "billing-engine",
    version: "0.3.0",
    capabilities: {
      "billing.get-invoice": defineCapability({
        description: "Return one invoice summary.",
        input: z.object({ invoiceId: z.string() }),
        output: z.object({ invoiceId: z.string(), total: z.number() }),
        access: "public",
        async run({ input }) {
          return { invoiceId: input.invoiceId, total: 42 };
        },
      }),
      "billing.refund": defineCapability({
        description: "Refund one invoice.",
        input: z.object({ invoiceId: z.string() }),
        output: z.object({ refunded: z.boolean() }),
        access: "authenticated",
        annotations: { destructive: true },
        async run() {
          return { refunded: true };
        },
      }),
    },
  });
}
