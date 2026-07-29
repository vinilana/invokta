import type { AgentSession } from "../domain/agent-session.js";

export interface StoreOptions {
  readonly signal?: AbortSignal;
}

export type CreateSessionResult = "created" | "exists";
export type SaveSessionResult = "saved" | "missing" | "conflict";

export interface AgentSessionStore {
  create(
    session: AgentSession,
    options?: StoreOptions,
  ): Promise<CreateSessionResult>;
  findById(
    sessionId: string,
    options?: StoreOptions,
  ): Promise<AgentSession | null>;
  save(
    session: AgentSession,
    expectedRevision: number,
    options?: StoreOptions,
  ): Promise<SaveSessionResult>;
}

export interface AgentSessionDependencies {
  readonly sessions: AgentSessionStore;
  readonly now: () => Date;
}
