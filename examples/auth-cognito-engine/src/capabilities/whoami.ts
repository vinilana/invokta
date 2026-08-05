import { defineCapability, EngineError } from "@invokta/core";
import { z } from "zod";

const input = z.object({});

const output = z.object({
  principalId: z.string().min(1),
  attributes: z.record(z.string(), z.unknown()),
});

/**
 * Reports the identity the boundary already proved.
 *
 * The result is derived from the trusted `context.principal` only. Capability
 * input carries no identity field, so a caller cannot describe — or claim — an
 * identity it does not hold.
 */
export const whoami = defineCapability({
  title: "Describe the authenticated principal",
  description:
    "Return the verified principal id and attributes of the current request.",
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
    const principal = context.principal;
    if (principal === null) {
      // Unreachable through the engine: "authenticated" is enforced before run.
      throw new EngineError({
        code: "FORBIDDEN",
        message: "An authenticated principal is required.",
      });
    }
    return {
      principalId: principal.id,
      attributes: { ...principal.attributes },
    };
  },
});
