import { EngineError } from "@ai-engine/core";
import { z } from "zod";

import type { SpecificationStore } from "../application/ports.js";
import type {
  SpecificationRecord,
  WorkflowStage,
} from "../domain/specification.js";
import {
  allowsTransition,
  stagesFor,
  type WorkflowTransition,
} from "../domain/workflow.js";

export const specIdInput = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u, {
    message:
      "A specification ID may contain only letters, digits, dot, underscore, and hyphen.",
  });

export const workflowStageOutput = z.enum([
  "drafted",
  "planned",
  "tasked",
  "implementing",
  "delivered",
]);

export const specificationOutput = z.object({
  summary: z.string().min(1),
  requirements: z.array(z.string().min(1)).min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
});

export const planOutput = z.object({
  approach: z.string().min(1),
  steps: z.array(z.string().min(1)).min(1),
  risks: z.array(z.string().min(1)),
});

export const taskOutput = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(["pending", "completed"]),
  evidence: z.string().nullable(),
});

export function specificationNotFound(specId: string): EngineError {
  return new EngineError({
    code: "EXECUTION_FAILED",
    message: "Specification not found.",
    publicDetails: { specId },
  });
}

export function stageConflict(
  specId: string,
  stage: WorkflowStage,
  transition: WorkflowTransition,
): EngineError {
  return new EngineError({
    code: "EXECUTION_FAILED",
    message: "The workflow stage does not allow this step.",
    publicDetails: {
      specId,
      stage,
      expectedStages: [...stagesFor(transition)],
    },
  });
}

export function concurrentChange(specId: string): EngineError {
  return new EngineError({
    code: "EXECUTION_FAILED",
    message: "The specification changed during this invocation.",
    publicDetails: { specId },
  });
}

export async function loadForTransition(
  specifications: SpecificationStore,
  specId: string,
  transition: WorkflowTransition,
): Promise<SpecificationRecord> {
  const record = await specifications.findById(specId);
  if (record === null) throw specificationNotFound(specId);
  if (!allowsTransition(record.stage, transition)) {
    throw stageConflict(specId, record.stage, transition);
  }
  return record;
}

export async function persist(
  specifications: SpecificationStore,
  record: SpecificationRecord,
  expectedRevision: number,
): Promise<void> {
  if (!(await specifications.save(record, expectedRevision))) {
    throw concurrentChange(record.specId);
  }
}
