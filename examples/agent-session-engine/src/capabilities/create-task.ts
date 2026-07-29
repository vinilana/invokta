import { defineCapability, EngineError } from "@invokta/core";
import { z } from "zod";

import { hasPermission } from "../application/authorization.js";
import type { AgentSessionDependencies } from "../application/ports.js";
import {
  agentTaskSchema,
  harnessSchema,
  identifierSchema,
  phaseSchema,
} from "../application/session-schema.js";
import { MAX_SESSION_TASKS } from "../domain/agent-session.js";
import { mutateSession } from "./session-contract.js";

const createTaskInput = z
  .object({
    sessionId: identifierSchema,
    taskId: identifierSchema,
    title: z.string().trim().min(1).max(200),
    phase: phaseSchema,
    assignedHarness: harnessSchema.optional(),
    assignedAgentId: identifierSchema.optional(),
  })
  .superRefine((input, context) => {
    if (
      (input.assignedHarness === undefined) !==
      (input.assignedAgentId === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "assignedHarness and assignedAgentId must be provided together.",
      });
    }
  });

export function createCreateTask(dependencies: AgentSessionDependencies) {
  return defineCapability({
    title: "Create agent task",
    description:
      "Create a portable task, optionally assigned to a harness and native agent identifier.",
    input: createTaskInput,
    output: z.object({
      sessionId: identifierSchema,
      sessionRevision: z.number().int().min(1),
      task: agentTaskSchema,
    }),
    access: ({ principal }) => hasPermission(principal, "agent-session:write"),
    timeoutMs: 10_000,
    annotations: {
      readOnly: false,
      destructive: false,
      idempotent: false,
      openWorld: false,
    },
    async run({ input, context }) {
      const updated = await mutateSession(
        dependencies,
        input.sessionId,
        context.signal,
        (current, now) => {
          if (current.tasks.some(({ id }) => id === input.taskId)) {
            throw new EngineError({
              code: "EXECUTION_FAILED",
              message: "Task already exists in this agent session.",
              publicDetails: {
                sessionId: input.sessionId,
                taskId: input.taskId,
              },
            });
          }
          if (current.tasks.length >= MAX_SESSION_TASKS) {
            throw new EngineError({
              code: "EXECUTION_FAILED",
              message: "The agent session task limit was reached.",
              publicDetails: {
                sessionId: input.sessionId,
                limit: MAX_SESSION_TASKS,
              },
            });
          }
          const owner =
            input.assignedHarness === undefined ||
            input.assignedAgentId === undefined
              ? null
              : {
                  harness: input.assignedHarness,
                  agentId: input.assignedAgentId,
                };
          return {
            ...current,
            revision: current.revision + 1,
            updatedAt: now,
            tasks: [
              ...current.tasks,
              {
                id: input.taskId,
                title: input.title,
                phase: input.phase,
                status: "pending" as const,
                owner,
                checkpoint: null,
                evidence: null,
                revision: 1,
                createdAt: now,
                updatedAt: now,
              },
            ],
          };
        },
      );
      const task = updated.tasks.find(({ id }) => id === input.taskId);
      if (task === undefined) throw new Error("Created task is unavailable.");
      return {
        sessionId: updated.sessionId,
        sessionRevision: updated.revision,
        task,
      };
    },
  });
}
