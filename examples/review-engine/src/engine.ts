import { createEngine } from "@invokta/core";

import type { ReviewDependencies } from "./application/ports.js";
import { createAssessTaskReadiness } from "./capabilities/assess-task-readiness.js";
import { createDeterministicReviewers } from "./infrastructure/deterministic-reviewers.js";

export function createReviewEngine(dependencies: ReviewDependencies) {
  return createEngine({
    name: "review-engine",
    version: "0.1.0",
    capabilities: {
      "review.assess-task-readiness": createAssessTaskReadiness(dependencies),
    },
  });
}

export function createDefaultReviewEngine() {
  return createReviewEngine(createDeterministicReviewers());
}

export const engine = createDefaultReviewEngine();
