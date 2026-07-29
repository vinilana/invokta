import { defineCapability, EngineError } from "@ai-engine/core";
import { z } from "zod";

import { hasPermission } from "../application/authorization.js";
import type { AgentSessionDependencies } from "../application/ports.js";
import {
  harnessSchema,
  identifierSchema,
} from "../application/session-schema.js";
import {
  type AgentHookEvent,
  type AgentSession,
  buildResumeContext,
  createAgentSession,
  MAX_SESSION_EVENTS,
} from "../domain/agent-session.js";
import {
  concurrentSessionChange,
  loadSession,
  sessionNotFound,
} from "./session-contract.js";

const MAX_RECORD_ATTEMPTS = 8;

const recordHookEventInput = z.object({
  sessionId: identifierSchema,
  harness: harnessSchema,
  nativeSessionId: z.string().trim().min(1).max(256),
  eventId: identifierSchema,
  eventName: z.string().trim().min(1).max(128),
  observedAt: z.string().min(1).max(64),
  workspaceRoot: z.string().trim().min(1).max(2_000),
  toolName: z.string().trim().min(1).max(256).nullable(),
  nativeAgentId: z.string().trim().min(1).max(256).nullable(),
  nativeTaskId: z.string().trim().min(1).max(256).nullable(),
  outcome: z.string().trim().min(1).max(128).nullable(),
  payloadSha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

function appendEvent(
  session: AgentSession,
  event: AgentHookEvent,
  updatedAt: string,
): AgentSession {
  if (session.events.length >= MAX_SESSION_EVENTS) {
    throw new EngineError({
      code: "EXECUTION_FAILED",
      message: "The agent session event limit was reached.",
      publicDetails: {
        sessionId: session.sessionId,
        limit: MAX_SESSION_EVENTS,
      },
    });
  }
  const linked = session.harnessSessions.some(
    (candidate) =>
      candidate.harness === event.harness &&
      candidate.nativeSessionId === event.nativeSessionId,
  );
  if (!linked && session.harnessSessions.length >= 64) {
    throw new EngineError({
      code: "EXECUTION_FAILED",
      message: "The agent session harness-link limit was reached.",
      publicDetails: { sessionId: session.sessionId, limit: 64 },
    });
  }
  return {
    ...session,
    revision: session.revision + 1,
    updatedAt,
    harnessSessions: linked
      ? session.harnessSessions
      : [
          ...session.harnessSessions,
          {
            harness: event.harness,
            nativeSessionId: event.nativeSessionId,
          },
        ],
    events: [...session.events, event],
  };
}

export function createRecordHookEvent(dependencies: AgentSessionDependencies) {
  return defineCapability({
    title: "Record agent harness hook event",
    description:
      "Persist normalized lifecycle metadata from a supported agent harness without prompts or tool payloads.",
    input: recordHookEventInput,
    output: z.object({
      sessionId: identifierSchema,
      sessionRevision: z.number().int().min(1),
      recorded: z.boolean(),
      resumed: z.boolean(),
      resumeContext: z.string().min(1).max(16_000),
    }),
    access: ({ principal }) => hasPermission(principal, "agent-session:hooks"),
    timeoutMs: 10_000,
    annotations: {
      readOnly: false,
      destructive: false,
      idempotent: true,
      openWorld: false,
    },
    async run({ input, context }) {
      let initial = await dependencies.sessions.findById(input.sessionId, {
        signal: context.signal,
      });
      let resumed = initial !== null;
      if (initial === null) {
        const createdAt = dependencies.now().toISOString();
        const candidate = createAgentSession({
          sessionId: input.sessionId,
          objective: `Observe ${input.harness} agent session ${input.nativeSessionId}.`,
          workspaceRoot: input.workspaceRoot,
          createdAt,
        });
        const created = await dependencies.sessions.create(candidate, {
          signal: context.signal,
        });
        resumed = created === "exists";
        initial =
          created === "created"
            ? candidate
            : await loadSession(dependencies, input.sessionId, context.signal);
      }

      const event: AgentHookEvent = {
        id: input.eventId,
        harness: input.harness,
        nativeSessionId: input.nativeSessionId,
        eventName: input.eventName,
        observedAt: input.observedAt,
        toolName: input.toolName,
        nativeAgentId: input.nativeAgentId,
        nativeTaskId: input.nativeTaskId,
        outcome: input.outcome,
        payloadSha256: input.payloadSha256,
      };

      for (let attempt = 0; attempt < MAX_RECORD_ATTEMPTS; attempt += 1) {
        const current =
          attempt === 0
            ? initial
            : await loadSession(dependencies, input.sessionId, context.signal);
        if (current.events.some(({ id }) => id === event.id)) {
          return {
            sessionId: current.sessionId,
            sessionRevision: current.revision,
            recorded: false,
            resumed,
            resumeContext: buildResumeContext(current),
          };
        }
        const updated = appendEvent(
          current,
          event,
          dependencies.now().toISOString(),
        );
        const saved = await dependencies.sessions.save(
          updated,
          current.revision,
          { signal: context.signal },
        );
        if (saved === "saved") {
          return {
            sessionId: updated.sessionId,
            sessionRevision: updated.revision,
            recorded: true,
            resumed,
            resumeContext: buildResumeContext(updated),
          };
        }
        if (saved === "missing") throw sessionNotFound(input.sessionId);
      }
      throw concurrentSessionChange(input.sessionId);
    },
  });
}
