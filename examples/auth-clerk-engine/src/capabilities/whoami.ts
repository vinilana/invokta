import { defineCapability, EngineError } from "@invokta/core";
import { z } from "zod";

/**
 * Reports the identity the boundary already proved. The result is derived
 * only from the trusted principal, never from the tool input, so the capability
 * stays a truthful probe of whatever authenticated the request.
 */
export const whoami = defineCapability({
  title: "Who am I",
  description: "Report the verified identity of the calling principal.",
  input: z.object({}),
  output: z.object({
    principalId: z.string().min(1),
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
    const { principal } = context;
    if (principal === null) {
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
