import { defineCapability, EngineError } from "@invokta/core";
import { z } from "zod";

import type { SpecDependencies } from "../application/ports.js";
import { withTasks } from "../domain/workflow.js";
import {
  loadForTransition,
  persist,
  specIdInput,
  taskOutput,
  workflowStageOutput,
} from "./workflow-contract.js";

export function createBreakDownTasks({
  specifications,
  author,
  permissions,
}: SpecDependencies) {
  return defineCapability({
    title: "Break down tasks",
    description:
      "Derive the executable task list from a planned specification and advance the workflow to tasked.",
    input: z.object({ specId: specIdInput }),
    output: z.object({
      specId: z.string().min(1),
      stage: workflowStageOutput,
      revision: z.number().int().min(1),
      tasks: z.array(taskOutput).min(1),
    }),
    access: async ({ principal, input }) => {
      if (principal === null) return false;
      return permissions.can(principal, "spec:break-down", input.specId);
    },
    timeoutMs: 60_000,
    annotations: {
      readOnly: false,
      destructive: false,
      idempotent: false,
      openWorld: false,
    },
    async run({ input, context }) {
      const record = await loadForTransition(
        specifications,
        input.specId,
        "break-down",
      );
      if (record.plan === null) {
        throw new EngineError({
          code: "EXECUTION_FAILED",
          message: "The planned specification has no plan.",
          publicDetails: { specId: record.specId },
        });
      }
      const titles = await author.draftTasks(
        { specification: record.specification, plan: record.plan },
        { signal: context.signal },
      );
      const tasked = withTasks(record, titles);
      await persist(specifications, tasked, record.revision);
      return {
        specId: tasked.specId,
        stage: tasked.stage,
        revision: tasked.revision,
        tasks: tasked.tasks.map((task) => ({ ...task })),
      };
    },
  });
}
