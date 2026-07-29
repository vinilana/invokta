import { defineCapability, EngineError } from "@invokta/core";
import { z } from "zod";

import type { SpecDependencies } from "../application/ports.js";
import { pendingTaskCount, withCompletedTask } from "../domain/workflow.js";
import {
  loadForTransition,
  persist,
  specIdInput,
  taskOutput,
  workflowStageOutput,
} from "./workflow-contract.js";

export function createCompleteTask({
  specifications,
  permissions,
}: SpecDependencies) {
  return defineCapability({
    title: "Complete task",
    description:
      "Record a task as implemented with its verification evidence and advance the workflow.",
    input: z.object({
      specId: specIdInput,
      taskId: z.string().trim().min(1).max(96),
      evidence: z.string().trim().min(1).max(500),
    }),
    output: z.object({
      specId: z.string().min(1),
      stage: workflowStageOutput,
      revision: z.number().int().min(1),
      task: taskOutput,
      pendingTasks: z.number().int().min(0),
    }),
    access: async ({ principal, input }) => {
      if (principal === null) return false;
      return permissions.can(principal, "spec:implement", input.specId);
    },
    timeoutMs: 30_000,
    annotations: {
      readOnly: false,
      destructive: false,
      idempotent: false,
      openWorld: false,
    },
    async run({ input }) {
      const record = await loadForTransition(
        specifications,
        input.specId,
        "complete-task",
      );
      const completion = withCompletedTask(
        record,
        input.taskId,
        input.evidence,
      );
      if (completion.outcome === "unknown-task") {
        throw new EngineError({
          code: "EXECUTION_FAILED",
          message: "Task not found in this specification.",
          publicDetails: { specId: record.specId, taskId: input.taskId },
        });
      }
      if (completion.outcome === "already-completed") {
        throw new EngineError({
          code: "EXECUTION_FAILED",
          message: "Task is already completed.",
          publicDetails: { specId: record.specId, taskId: completion.task.id },
        });
      }

      await persist(specifications, completion.record, record.revision);
      return {
        specId: completion.record.specId,
        stage: completion.record.stage,
        revision: completion.record.revision,
        task: { ...completion.task },
        pendingTasks: pendingTaskCount(completion.record),
      };
    },
  });
}
