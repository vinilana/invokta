import type { ReviewCandidate } from "./domain/review.js";

export const exampleCandidate: ReviewCandidate = {
  taskId: "TASK-DEMO",
  summary:
    "Prevent an agent from declaring completion before review gates pass.",
  acceptanceCriteria: [
    {
      id: "AC-1",
      statement: "Blocking code review findings prevent completion.",
    },
    {
      id: "AC-2",
      statement: "Every acceptance criterion requires passing evidence.",
    },
  ],
  change: {
    summary: "Add a fail-closed readiness decision.",
    files: ["src/readiness.ts", "test/readiness.test.ts"],
    patch: "+export const ready = blockers.length === 0;\n",
  },
  evidence: [
    {
      id: "TEST-1",
      kind: "test",
      criterionIds: ["AC-1"],
      passed: true,
      command: "vitest run readiness.test.ts",
      summary: "A blocking finding kept readiness false.",
    },
    {
      id: "TEST-2",
      kind: "test",
      criterionIds: ["AC-2"],
      passed: true,
      command: "vitest run readiness.test.ts",
      summary: "Missing criterion evidence kept readiness false.",
    },
    {
      id: "ADV-TEST-1",
      kind: "adversarial-test",
      criterionIds: ["AC-1"],
      passed: true,
      command: "vitest run readiness.adversarial.test.ts",
      summary: "A major finding was injected and completion remained blocked.",
    },
    {
      id: "ADV-TEST-2",
      kind: "adversarial-test",
      criterionIds: ["AC-2"],
      passed: true,
      command: "vitest run readiness.adversarial.test.ts",
      summary:
        "Criterion evidence was removed and completion remained blocked.",
    },
  ],
};
