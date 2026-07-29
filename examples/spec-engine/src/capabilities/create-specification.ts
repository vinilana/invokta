import { defineCapability, EngineError } from "@invokta/core";
import { z } from "zod";

import type { SpecDependencies } from "../application/ports.js";
import { draftRecord } from "../domain/workflow.js";
import {
  specIdInput,
  specificationOutput,
  workflowStageOutput,
} from "./workflow-contract.js";

export function createCreateSpecification({
  specifications,
  author,
  permissions,
}: SpecDependencies) {
  return defineCapability({
    title: "Create specification",
    description:
      "Turn a delivery intent into a reviewable specification and open the spec-driven workflow.",
    input: z.object({
      specId: specIdInput,
      intent: z.string().trim().min(10).max(2_000),
    }),
    output: z.object({
      specId: z.string().min(1),
      stage: workflowStageOutput,
      revision: z.number().int().min(1),
      specification: specificationOutput,
    }),
    access: async ({ principal, input }) => {
      if (principal === null) return false;
      return permissions.can(principal, "spec:create", input.specId);
    },
    timeoutMs: 60_000,
    annotations: {
      readOnly: false,
      destructive: false,
      idempotent: false,
      openWorld: false,
    },
    async run({ input, context }) {
      const specification = await author.draftSpecification(
        { specId: input.specId, intent: input.intent },
        { signal: context.signal },
      );
      const record = draftRecord(input.specId, specification);
      if (!(await specifications.create(record))) {
        throw new EngineError({
          code: "EXECUTION_FAILED",
          message: "Specification already exists.",
          publicDetails: { specId: input.specId },
        });
      }
      return {
        specId: record.specId,
        stage: record.stage,
        revision: record.revision,
        specification: {
          summary: specification.summary,
          requirements: specification.requirements.slice(),
          acceptanceCriteria: specification.acceptanceCriteria.slice(),
        },
      };
    },
  });
}
