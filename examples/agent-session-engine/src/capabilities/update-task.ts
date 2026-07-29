import { defineCapability, EngineError } from "@invokta/core";
import { z } from "zod";

import { hasPermission } from "../application/authorization.js";
import type { AgentSessionDependencies } from "../application/ports.js";
import {
  agentTaskSchema,
  harnessSchema,
  identifierSchema,
  phaseSchema,
  taskStatusSchema,
} from "../application/session-schema.js";
import type { TaskOwner } from "../domain/agent-session.js";
import { mutateSession } from "./session-contract.js";

const updateTaskInput = z
  .object({
    sessionId: identifierSchema,
    taskId: identifierSchema,
    expectedTaskRevision: z.number().int().min(1),
    status: taskStatusSchema.optional(),
    phase: phaseSchema.optional(),
    assignedHarness: harnessSchema.nullable().optional(),
    assignedAgentId: identifierSchema.nullable().optional(),
    checkpoint: z.string().trim().min(1).max(4_000).nullable().optional(),
    evidence: z.string().trim().min(1).max(4_000).nullable().optional(),
  })
  .superRefine((input, context) => {
    const ownerTouched =
      input.assignedHarness !== undefined ||
      input.assignedAgentId !== undefined;
    const ownerComplete =
      input.assignedHarness !== undefined &&
      input.assignedAgentId !== undefined;
    const bothNull =
      input.assignedHarness === null && input.assignedAgentId === null;
    const bothValues =
      typeof input.assignedHarness === "string" &&
      typeof input.assignedAgentId === "string";
    if (ownerTouched && (!ownerComplete || (!bothNull && !bothValues))) {
      context.addIssue({
        code: "custom",
        message:
          "assignedHarness and assignedAgentId must both be values or both be null.",
      });
    }
    if (
      input.status === undefined &&
      input.phase === undefined &&
      !ownerTouched &&
      input.checkpoint === undefined &&
      input.evidence === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "At least one task field must be updated.",
      });
    }
  });

export function createUpdateTask(dependencies: AgentSessionDependencies) {
  return defineCapability({
    title: "Update or hand off agent task",
    description:
      "Advance a task, record its checkpoint or evidence, or assign it to another harness and agent.",
    input: updateTaskInput,
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
          const task = current.tasks.find(({ id }) => id === input.taskId);
          if (task === undefined) {
            throw new EngineError({
              code: "EXECUTION_FAILED",
              message: "Task not found in this agent session.",
              publicDetails: {
                sessionId: input.sessionId,
                taskId: input.taskId,
              },
            });
          }
          if (task.revision !== input.expectedTaskRevision) {
            throw new EngineError({
              code: "EXECUTION_FAILED",
              message: "The task changed before this update.",
              publicDetails: {
                sessionId: input.sessionId,
                taskId: input.taskId,
                expectedTaskRevision: input.expectedTaskRevision,
              },
            });
          }
          let owner: TaskOwner | null = task.owner;
          if (
            input.assignedHarness === null &&
            input.assignedAgentId === null
          ) {
            owner = null;
          } else if (
            input.assignedHarness !== undefined &&
            input.assignedHarness !== null &&
            input.assignedAgentId !== undefined &&
            input.assignedAgentId !== null
          ) {
            owner = {
              harness: input.assignedHarness,
              agentId: input.assignedAgentId,
            };
          }
          const changedTask = {
            ...task,
            ...(input.status === undefined ? {} : { status: input.status }),
            ...(input.phase === undefined ? {} : { phase: input.phase }),
            owner,
            ...(input.checkpoint === undefined
              ? {}
              : { checkpoint: input.checkpoint }),
            ...(input.evidence === undefined
              ? {}
              : { evidence: input.evidence }),
            revision: task.revision + 1,
            updatedAt: now,
          };
          if (
            changedTask.status === "completed" &&
            changedTask.evidence === null
          ) {
            throw new EngineError({
              code: "EXECUTION_FAILED",
              message: "A completed task requires verification evidence.",
              publicDetails: {
                sessionId: input.sessionId,
                taskId: input.taskId,
              },
            });
          }
          return {
            ...current,
            revision: current.revision + 1,
            updatedAt: now,
            tasks: current.tasks.map((candidate) =>
              candidate.id === input.taskId ? changedTask : candidate,
            ),
          };
        },
      );
      const task = updated.tasks.find(({ id }) => id === input.taskId);
      if (task === undefined) throw new Error("Updated task is unavailable.");
      return {
        sessionId: updated.sessionId,
        sessionRevision: updated.revision,
        task,
      };
    },
  });
}
