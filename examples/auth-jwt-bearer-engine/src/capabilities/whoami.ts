import { defineCapability, EngineError } from "@invokta/core";
import { z } from "zod";

const input = z.object({});

const output = z.object({
  principalId: z.string(),
  attributes: z.record(z.string(), z.unknown()),
});

/**
 * Echoes the caller's verified identity.
 *
 * `access: "authenticated"` closes the capability to anonymous callers on every
 * channel, and `run` reads only `context.principal`. Input cannot name, widen,
 * or override an identity, so the same capability is safe over MCP HTTP, MCP
 * stdio, the CLI, and direct invocation.
 */
export const whoami = defineCapability({
  title: "Who am I",
  description: "Return the verified identity of the current caller.",
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
      // Unreachable through the engine: `authenticated` already denied the
      // call. Kept so the handler never invents an identity of its own.
      throw new EngineError({
        code: "UNAUTHENTICATED",
        message: "The request has no verified identity.",
      });
    }
    return {
      principalId: principal.id,
      attributes: { ...(principal.attributes ?? {}) },
    };
  },
});
