import { defineCapability, EngineError } from "@ai-engine/core";
import { z } from "zod";

import { hasPermission } from "../application/authorization.js";
import type { AgentSessionDependencies } from "../application/ports.js";
import {
  identifierSchema,
  phaseSchema,
  sessionStatusSchema,
} from "../application/session-schema.js";
import {
  loadSession,
  sessionNotFound,
  sessionViewSchema,
  toSessionView,
} from "./session-contract.js";

export function createCheckpointSession(
  dependencies: AgentSessionDependencies,
) {
  return defineCapability({
    title: "Checkpoint agent session",
    description:
      "Persist the current execution phase, status, checkpoint, and next action for a later harness.",
    input: z.object({
      sessionId: identifierSchema,
      expectedRevision: z.number().int().min(1),
      phase: phaseSchema,
      status: sessionStatusSchema,
      checkpoint: z.string().trim().min(1).max(4_000),
      nextAction: z.string().trim().min(1).max(4_000).nullable(),
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
      const current = await loadSession(
        dependencies,
        input.sessionId,
        context.signal,
      );
      if (current.revision !== input.expectedRevision) {
        throw new EngineError({
          code: "EXECUTION_FAILED",
          message: "The session changed before this checkpoint.",
          publicDetails: {
            sessionId: input.sessionId,
            expectedRevision: input.expectedRevision,
          },
        });
      }
      const updated = {
        ...current,
        phase: input.phase,
        status: input.status,
        checkpoint: input.checkpoint,
        nextAction: input.nextAction,
        revision: current.revision + 1,
        updatedAt: dependencies.now().toISOString(),
      };
      const saved = await dependencies.sessions.save(
        updated,
        current.revision,
        {
          signal: context.signal,
        },
      );
      if (saved === "missing") throw sessionNotFound(input.sessionId);
      if (saved === "conflict") {
        throw new EngineError({
          code: "EXECUTION_FAILED",
          message: "The session changed before this checkpoint.",
          publicDetails: {
            sessionId: input.sessionId,
            expectedRevision: input.expectedRevision,
          },
        });
      }
      return toSessionView(updated);
    },
  });
}
