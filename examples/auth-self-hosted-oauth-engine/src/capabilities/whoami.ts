import { defineCapability } from "@invokta/core";
import { z } from "zod";

export const whoAmI = defineCapability({
  title: "Inspect the authenticated identity",
  description:
    "Returns the authenticated principal ID and its safe OAuth attributes.",
  input: z.object({}),
  output: z.object({
    principalId: z.string().min(1),
    clientId: z.string().optional(),
    scopes: z.array(z.string()),
  }),
  access: "authenticated",
  timeoutMs: 5_000,
  annotations: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
  },
  async run({ context }) {
    if (context.principal === null) {
      throw new Error("An authenticated principal is required.");
    }
    return {
      principalId: context.principal.id,
      ...(typeof context.principal.attributes?.clientId === "string"
        ? { clientId: context.principal.attributes.clientId }
        : {}),
      scopes: Array.isArray(context.principal.attributes?.scopes)
        ? context.principal.attributes.scopes.filter(
            (scope): scope is string => typeof scope === "string",
          )
        : [],
    };
  },
});
