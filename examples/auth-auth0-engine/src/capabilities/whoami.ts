import { defineCapability, EngineError } from "@invokta/core";
import { z } from "zod";

const input = z.object({});

const output = z.object({
  principalId: z.string(),
  attributes: z.record(z.string(), z.unknown()),
});

/**
 * Echoes the identity Invokta trusts for this request.
 *
 * The result is derived only from `context.principal`, so it proves what the
 * verified Auth0 access token established. Capability input cannot influence
 * it, and the capability never sees the token, the tenant, or `jose`.
 */
export const whoami = defineCapability({
  title: "Who am I",
  description:
    "Return the verified principal Invokta derived from the request credential.",
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
