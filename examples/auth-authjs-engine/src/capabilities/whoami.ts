import { defineCapability, EngineError } from "@invokta/core";
import { z } from "zod";

/**
 * The identity probe every authentication example ships.
 *
 * The result is derived only from the trusted principal on the execution
 * context. Capability input cannot name, extend, or override an identity.
 */
export const whoami = defineCapability({
  title: "Who am I",
  description:
    "Return the trusted principal established by the calling channel.",
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
    const { principal } = context;
    if (principal === null) {
      // Unreachable through the engine: "authenticated" already denied it.
      throw new EngineError({
        code: "EXECUTION_FAILED",
        message: "The capability requires an authenticated principal.",
      });
    }

    return {
      principalId: principal.id,
      attributes: { ...principal.attributes },
    };
  },
});
