import { defineCapability, EngineError } from "@invokta/core";
import { z } from "zod";

const input = z.object({});

const output = z.object({
  principalId: z.string(),
  attributes: z.record(z.string(), z.unknown()),
});

/**
 * Echoes the trusted principal so every channel of this example can be
 * verified end to end. The handler reads identity from `context` only:
 * capability input can never choose or widen the caller's identity.
 */
export const whoami = defineCapability({
  title: "Who am I",
  description:
    "Return the authenticated principal's identifier and safe attributes.",
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
