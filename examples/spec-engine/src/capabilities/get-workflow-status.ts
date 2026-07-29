import { defineCapability } from "@invokta/core";
import { z } from "zod";

import type { SpecDependencies } from "../application/ports.js";
import { nextCapability, pendingTaskCount } from "../domain/workflow.js";
import {
  planOutput,
  specIdInput,
  specificationNotFound,
  specificationOutput,
  taskOutput,
  workflowStageOutput,
} from "./workflow-contract.js";

export function createGetWorkflowStatus({
  specifications,
  permissions,
}: SpecDependencies) {
  return defineCapability({
    title: "Get workflow status",
    description:
      "Return the current specification, plan, tasks, and the capability that should run next.",
    input: z.object({ specId: specIdInput }),
    output: z.object({
      specId: z.string().min(1),
      stage: workflowStageOutput,
      revision: z.number().int().min(1),
      specification: specificationOutput,
      plan: planOutput.nullable(),
      tasks: z.array(taskOutput),
      pendingTasks: z.number().int().min(0),
      nextCapability: z.string().min(1).nullable(),
    }),
    access: async ({ principal, input }) => {
      if (principal === null) return false;
      return permissions.can(principal, "spec:read", input.specId);
    },
    timeoutMs: 10_000,
    annotations: {
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: false,
    },
    async run({ input }) {
      const record = await specifications.findById(input.specId);
      if (record === null) throw specificationNotFound(input.specId);
      return {
        specId: record.specId,
        stage: record.stage,
        revision: record.revision,
        specification: {
          summary: record.specification.summary,
          requirements: record.specification.requirements.slice(),
          acceptanceCriteria: record.specification.acceptanceCriteria.slice(),
        },
        plan:
          record.plan === null
            ? null
            : {
                approach: record.plan.approach,
                steps: record.plan.steps.slice(),
                risks: record.plan.risks.slice(),
              },
        tasks: record.tasks.map((task) => ({ ...task })),
        pendingTasks: pendingTaskCount(record),
        nextCapability: nextCapability(record),
      };
    },
  });
}
