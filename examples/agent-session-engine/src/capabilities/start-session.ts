import { defineCapability, EngineError } from "@invokta/core";
import { z } from "zod";

import { hasPermission } from "../application/authorization.js";
import type { AgentSessionDependencies } from "../application/ports.js";
import { identifierSchema } from "../application/session-schema.js";
import { createAgentSession } from "../domain/agent-session.js";
import { sessionViewSchema, toSessionView } from "./session-contract.js";

export function createStartSession(dependencies: AgentSessionDependencies) {
  return defineCapability({
    title: "Start portable agent session",
    description:
      "Create a durable, harness-independent session that can be resumed by another agent harness.",
    input: z.object({
      sessionId: identifierSchema,
      objective: z.string().trim().min(1).max(2_000),
      workspaceRoot: z.string().trim().min(1).max(2_000),
    }),
    output: sessionViewSchema,
    access: ({ principal }) => hasPermission(principal, "agent-session:write"),
    timeoutMs: 10_000,
    annotations: {
      readOnly: false,
      destructive: false,
      idempotent: false,
      openWorld: false,
    },
    async run({ input, context }) {
      const createdAt = dependencies.now().toISOString();
      const session = createAgentSession({ ...input, createdAt });
      const result = await dependencies.sessions.create(session, {
        signal: context.signal,
      });
      if (result === "exists") {
        throw new EngineError({
          code: "EXECUTION_FAILED",
          message: "Agent session already exists.",
          publicDetails: { sessionId: input.sessionId },
        });
      }
      return toSessionView(session);
    },
  });
}
