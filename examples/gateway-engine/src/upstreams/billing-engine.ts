import { CapabilityError, createEngine, defineCapability } from "@invokta/core";
import { z } from "zod";

interface Invoice {
  readonly invoiceId: string;
  readonly customerId: string;
  readonly totalCents: number;
  refunded: boolean;
}

/** The finance team's Action Engine, running in the gateway process. */
export function createBillingEngine() {
  const invoices = new Map<string, Invoice>([
    [
      "INV-1001",
      {
        invoiceId: "INV-1001",
        customerId: "C-1",
        totalCents: 12_900,
        refunded: false,
      },
    ],
    [
      "INV-1002",
      {
        invoiceId: "INV-1002",
        customerId: "C-2",
        totalCents: 4_500,
        refunded: true,
      },
    ],
  ]);
  const invoiceOutput = z.object({
    invoiceId: z.string(),
    customerId: z.string(),
    totalCents: z.number().int(),
    refunded: z.boolean(),
  });

  return createEngine({
    name: "billing-engine",
    version: "2.3.0",
    capabilities: {
      "billing.get-invoice": defineCapability({
        title: "Get invoice",
        description: "Return one invoice with its total and refund status.",
        input: z.object({ invoiceId: z.string().min(1) }),
        output: invoiceOutput,
        access: "authenticated",
        annotations: { readOnly: true },
        errors: {
          INVOICE_NOT_FOUND: { description: "No invoice has this ID." },
        },
        async run({ input }) {
          const invoice = invoices.get(input.invoiceId);
          if (invoice === undefined) {
            throw new CapabilityError("INVOICE_NOT_FOUND");
          }
          return { ...invoice };
        },
      }),
      "billing.refund-invoice": defineCapability({
        title: "Refund invoice",
        description: "Refund the full total of one paid invoice.",
        input: z.object({ invoiceId: z.string().min(1) }),
        output: invoiceOutput,
        access: "authenticated",
        annotations: { destructive: true, idempotent: false },
        errors: {
          INVOICE_NOT_FOUND: { description: "No invoice has this ID." },
          ALREADY_REFUNDED: { description: "The invoice is already refunded." },
        },
        async run({ input }) {
          const invoice = invoices.get(input.invoiceId);
          if (invoice === undefined) {
            throw new CapabilityError("INVOICE_NOT_FOUND");
          }
          if (invoice.refunded) throw new CapabilityError("ALREADY_REFUNDED");
          invoice.refunded = true;
          return { ...invoice };
        },
      }),
    },
  });
}
