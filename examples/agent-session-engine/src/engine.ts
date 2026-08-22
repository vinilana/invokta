import { createEngine, type EngineEvent } from "@invokta/core";

import type { AgentSessionDependencies } from "./application/ports.js";
import { createCheckpointSession } from "./capabilities/checkpoint-session.js";
import { createCreateTask } from "./capabilities/create-task.js";
import { createGetSession } from "./capabilities/get-session.js";
import { createRecordHookEvent } from "./capabilities/record-hook-event.js";
import { createStartSession } from "./capabilities/start-session.js";
import { createUpdateTask } from "./capabilities/update-task.js";
import { fileAgentSessionConnector } from "./infrastructure/file-agent-session-store.js";

export interface AgentSessionEngineOptions {
  readonly onEvent?: (event: EngineEvent) => void | Promise<void>;
}

export function createAgentSessionEngine(
  dependencies: AgentSessionDependencies,
  options: AgentSessionEngineOptions = {},
) {
  return createEngine({
    name: "agent-session-engine",
    version: "0.1.0",
    capabilities: {
      "agent-session.start": createStartSession(dependencies),
      "agent-session.record-hook-event": createRecordHookEvent(dependencies),
      "agent-session.create-task": createCreateTask(dependencies),
      "agent-session.update-task": createUpdateTask(dependencies),
      "agent-session.checkpoint": createCheckpointSession(dependencies),
      "agent-session.get": createGetSession(dependencies),
    },
    ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
  });
}

export const AGENT_SESSION_DATA_DIRECTORY_ENV = "AGENT_SESSION_ENGINE_DATA_DIR";

export function resolveAgentSessionDataDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string {
  const configured = environment[AGENT_SESSION_DATA_DIRECTORY_ENV];
  return configured === undefined || configured.trim() === ""
    ? `${cwd}/.agent-sessions`
    : configured;
}

export function createDefaultAgentSessionEngine(
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
) {
  const connector = fileAgentSessionConnector.create(
    { dataDirectory: resolveAgentSessionDataDirectory(environment, cwd) },
    {},
  );
  return createAgentSessionEngine({
    sessions: connector.ports.sessions,
    now: () => new Date(),
  });
}

export const engine = createDefaultAgentSessionEngine();
