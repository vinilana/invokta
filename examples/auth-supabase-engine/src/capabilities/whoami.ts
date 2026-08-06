import { defineCapability, EngineError } from "@invokta/core";
import { z } from "zod";

/**
 * The smallest capability that proves an identity boundary works.
 *
 * `access: "authenticated"` closes it to anonymous callers, and `run` derives
 * its whole answer from `context.principal`. The input schema is empty on
 * purpose: nothing a caller sends can influence who the engine thinks it is
 * talking to.
 */
export const whoami = defineCapability({
  title: "Describe the authenticated principal",
  description:
    "Return the identity the request boundary verified for this invocation.",
  input: z.object({}),
  output: z.object({
    principalId: z.string().min(1),
    attributes: z.record(z.string(), z.unknown()),
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
    const principal = context.principal;
    if (principal === null) {
      // Unreachable through the access rule; kept so the handler never
      // invents an identity if it is ever reused with another rule.
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
