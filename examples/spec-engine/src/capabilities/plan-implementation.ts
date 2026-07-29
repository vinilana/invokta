import { defineCapability } from "@invokta/core";
import { z } from "zod";

import type { SpecDependencies } from "../application/ports.js";
import { withPlan } from "../domain/workflow.js";
import {
  loadForTransition,
  persist,
  planOutput,
  specIdInput,
  workflowStageOutput,
} from "./workflow-contract.js";

export function createPlanImplementation({
  specifications,
  author,
  permissions,
}: SpecDependencies) {
  return defineCapability({
    title: "Plan implementation",
    description:
      "Derive the technical plan for a drafted specification and advance the workflow to planned.",
    input: z.object({ specId: specIdInput }),
    output: z.object({
      specId: z.string().min(1),
      stage: workflowStageOutput,
      revision: z.number().int().min(1),
      plan: planOutput,
    }),
    access: async ({ principal, input }) => {
      if (principal === null) return false;
      return permissions.can(principal, "spec:plan", input.specId);
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
        "plan",
      );
      const plan = await author.draftPlan(
        { specification: record.specification },
        { signal: context.signal },
      );
      const planned = withPlan(record, plan);
      await persist(specifications, planned, record.revision);
      return {
        specId: planned.specId,
        stage: planned.stage,
        revision: planned.revision,
        plan: {
          approach: plan.approach,
          steps: plan.steps.slice(),
          risks: plan.risks.slice(),
        },
      };
    },
  });
}
