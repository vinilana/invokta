import { createEngine, defineCapability } from "@invokta/core";
import { z } from "zod";
import { serveMcpStdio } from "../../dist/index.js";

const capability = (description) =>
  defineCapability({
    description,
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    access: "authenticated",
    async run() {
      return { ok: true };
    },
  });

const engine = createEngine({
  name: "stdio-visibility-engine",
  version: "0.1.0",
  capabilities: {
    "billing.get-invoice": capability("Read one invoice."),
    "billing.refund": capability("Refund one invoice."),
  },
});

// The host-configured local principal sees only what its scopes allow.
await serveMcpStdio(engine, {
  principal: { id: "local-reader", attributes: { scopes: ["billing:read"] } },
  visibility: ({ principal, capabilityId }) =>
    capabilityId === "billing.get-invoice" ||
    principal?.attributes?.scopes?.includes("billing:refund") === true,
});
