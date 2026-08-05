import { defineCapability, EngineError } from "@invokta/core";
import { z } from "zod";

const input = z.object({});

const output = z.object({
  principalId: z.string().min(1),
  attributes: z.record(z.string(), z.unknown()),
});

/**
 * Reports the caller's verified identity.
 *
 * Everything in the result comes from the trusted principal, never from the
 * capability input, so the capability proves what the authentication hook
 * decided without becoming a way to assert an identity.
 */
export const whoami = defineCapability({
  title: "Who am I",
  description: "Return the verified identity of the calling principal.",
  input,
  output,
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
      // Unreachable through the engine: "authenticated" is applied first.
      throw new EngineError({
        code: "UNAUTHENTICATED",
        message: "This capability requires an authenticated principal.",
      });
    }
    return {
      principalId: principal.id,
      attributes: { ...principal.attributes },
    };
  },
});
