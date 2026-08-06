import { defineCapability, EngineError } from "@invokta/core";
import { z } from "zod";

/**
 * The smallest capability that proves an authentication integration works.
 *
 * It takes no input and derives its whole result from the trusted principal
 * the boundary produced, so a caller cannot influence the reported identity.
 */
export const whoami = defineCapability({
  title: "Who am I",
  description: "Report the verified identity of the calling service.",
  input: z.object({}),
  output: z.object({
    principalId: z.string(),
    attributes: z.record(z.string(), z.unknown()),
  }),
  access: "authenticated",
  annotations: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
  },
  async run({ context }) {
    const principal = context.principal;
    if (principal === null) {
      // Unreachable: access "authenticated" already denied an anonymous call.
      throw new EngineError({
        code: "UNAUTHENTICATED",
        message: "The request has no verified identity.",
      });
    }
    return {
      principalId: principal.id,
      attributes: { ...principal.attributes },
    };
  },
});
