import { createEngine } from "@ai-engine/core";

import type { SpecDependencies } from "./application/ports.js";
import { createBreakDownTasks } from "./capabilities/break-down-tasks.js";
import { createCompleteTask } from "./capabilities/complete-task.js";
import { createCreateSpecification } from "./capabilities/create-specification.js";
import { createGetWorkflowStatus } from "./capabilities/get-workflow-status.js";
import { createPlanImplementation } from "./capabilities/plan-implementation.js";
import type { SpecificationRecord } from "./domain/specification.js";
import { createAttributeWorkflowPermissionChecker } from "./infrastructure/attribute-workflow-permission-checker.js";
import { createInMemorySpecificationStore } from "./infrastructure/in-memory-specification-store.js";
import { createTemplateSpecificationAuthor } from "./infrastructure/template-specification-author.js";

export function createSpecEngine(dependencies: SpecDependencies) {
  return createEngine({
    name: "spec-engine",
    version: "0.1.0",
    capabilities: {
      "spec.create-specification": createCreateSpecification(dependencies),
      "spec.plan-implementation": createPlanImplementation(dependencies),
      "spec.break-down-tasks": createBreakDownTasks(dependencies),
      "spec.complete-task": createCompleteTask(dependencies),
      "spec.get-workflow-status": createGetWorkflowStatus(dependencies),
    },
  });
}

/**
 * The store is process-local, so every entrypoint starts from this drafted
 * specification. It keeps the CLI and MCP channels useful without a database.
 */
export const seededSpecification: SpecificationRecord = {
  specId: "SPEC-1",
  stage: "drafted",
  revision: 1,
  specification: {
    summary: "Deliver: publish a ticket classification capability.",
    requirements: [
      "The system must publish a ticket classification capability.",
      "The system must reject a request from an unauthorized principal.",
    ],
    acceptanceCriteria: [
      "An automated test proves requirement 1.",
      "An automated test proves requirement 2.",
    ],
  },
  plan: null,
  tasks: [],
};

export function createDefaultSpecEngine() {
  return createSpecEngine({
    specifications: createInMemorySpecificationStore([seededSpecification]),
    author: createTemplateSpecificationAuthor(),
    permissions: createAttributeWorkflowPermissionChecker(),
  });
}

export const engine = createDefaultSpecEngine();
