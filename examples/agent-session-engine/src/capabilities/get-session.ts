import { defineCapability } from "@ai-engine/core";
import { z } from "zod";

import { hasPermission } from "../application/authorization.js";
import type { AgentSessionDependencies } from "../application/ports.js";
import { identifierSchema } from "../application/session-schema.js";
import {
  loadSession,
  sessionViewSchema,
  toSessionView,
} from "./session-contract.js";

export function createGetSession(dependencies: AgentSessionDependencies) {
  return defineCapability({
    title: "Get portable agent session",
    description:
      "Return the complete durable session and a bounded context block for the next harness.",
    input: z.object({ sessionId: identifierSchema }),
    output: sessionViewSchema,
    access: ({ principal }) => hasPermission(principal, "agent-session:read"),
    timeoutMs: 10_000,
    annotations: {
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: false,
    },
    async run({ input, context }) {
      return toSessionView(
        await loadSession(dependencies, input.sessionId, context.signal),
      );
    },
  });
}
