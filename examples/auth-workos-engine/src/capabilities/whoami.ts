import { defineCapability, EngineError } from "@invokta/core";
import { z } from "zod";

const input = z.object({});

const output = z.object({
  principalId: z.string(),
  attributes: z.record(z.string(), z.unknown()),
});

/**
 * Echoes the trusted identity of the caller.
 *
 * The result is derived only from `context.principal`, which the HTTP
 * authentication hook produced from a verified WorkOS access token. The
 * capability never sees the credential, the request headers, or the WorkOS
 * SDK, and the empty input schema leaves the caller nothing to influence.
 */
export const whoami = defineCapability({
  title: "Who am I",
  description: "Return the verified identity of the current caller.",
  input,
  output,
  access: "authenticated",
  timeoutMs: 5_000,
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
        message: "An authenticated principal is required.",
      });
    }
    return {
      principalId: principal.id,
      attributes: { ...principal.attributes },
    };
  },
});
