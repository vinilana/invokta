import { EngineError } from "@invokta/core";
import type { z } from "zod";

import type { AgentSessionDependencies } from "../application/ports.js";
import {
  agentSessionSchema,
  sessionViewSchema,
} from "../application/session-schema.js";
import {
  type AgentSession,
  buildResumeContext,
} from "../domain/agent-session.js";

const MAX_MUTATION_ATTEMPTS = 8;

export { agentSessionSchema, sessionViewSchema };

export type SessionView = z.infer<typeof sessionViewSchema>;

export function toSessionView(session: AgentSession): SessionView {
  return sessionViewSchema.parse({
    ...structuredClone(session),
    eventCount: session.events.length,
    resumeContext: buildResumeContext(session),
  });
}

export function sessionNotFound(sessionId: string): EngineError {
  return new EngineError({
    code: "EXECUTION_FAILED",
    message: "Agent session not found.",
    publicDetails: { sessionId },
  });
}

export function concurrentSessionChange(sessionId: string): EngineError {
  return new EngineError({
    code: "EXECUTION_FAILED",
    message: "The agent session changed during this operation.",
    publicDetails: { sessionId },
  });
}

export async function loadSession(
  dependencies: AgentSessionDependencies,
  sessionId: string,
  signal: AbortSignal,
): Promise<AgentSession> {
  const session = await dependencies.sessions.findById(sessionId, { signal });
  if (session === null) throw sessionNotFound(sessionId);
  return session;
}

export async function mutateSession(
  dependencies: AgentSessionDependencies,
  sessionId: string,
  signal: AbortSignal,
  mutate: (current: AgentSession, now: string) => AgentSession,
): Promise<AgentSession> {
  for (let attempt = 0; attempt < MAX_MUTATION_ATTEMPTS; attempt += 1) {
    const current = await loadSession(dependencies, sessionId, signal);
    const updated = mutate(current, dependencies.now().toISOString());
    const saved = await dependencies.sessions.save(updated, current.revision, {
      signal,
    });
    if (saved === "saved") return updated;
    if (saved === "missing") throw sessionNotFound(sessionId);
  }
  throw concurrentSessionChange(sessionId);
}
