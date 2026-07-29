import { defineCapability } from "@invokta/core";
import { z } from "zod";

import type { ReviewDependencies } from "../application/ports.js";
import { standardReviewPolicy } from "../domain/policy.js";
import { assessReadiness } from "../domain/readiness.js";

const identifier = z
  .string()
  .trim()
  .min(1)
  .max(96)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

const criterionInput = z.object({
  id: identifier,
  statement: z.string().trim().min(1).max(1_000),
});

const evidenceInput = z.object({
  id: identifier,
  kind: z.enum([
    "test",
    "adversarial-test",
    "typecheck",
    "lint",
    "build",
    "manual-inspection",
  ]),
  criterionIds: z.array(identifier).min(1).max(50),
  passed: z.boolean(),
  command: z.string().trim().min(1).max(1_000).nullable(),
  summary: z.string().trim().min(1).max(2_000),
});

const input = z
  .object({
    taskId: identifier,
    summary: z.string().trim().min(1).max(2_000),
    acceptanceCriteria: z.array(criterionInput).min(1).max(50),
    change: z.object({
      summary: z.string().trim().min(1).max(2_000),
      files: z.array(z.string().trim().min(1).max(500)).min(1).max(200),
      patch: z.string().min(1).max(200_000),
    }),
    evidence: z.array(evidenceInput).min(1).max(200),
  })
  .superRefine((candidate, context) => {
    const criterionIds = new Set<string>();
    for (const [index, criterion] of candidate.acceptanceCriteria.entries()) {
      if (criterionIds.has(criterion.id)) {
        context.addIssue({
          code: "custom",
          message: "Acceptance criterion IDs must be unique.",
          path: ["acceptanceCriteria", index, "id"],
        });
      }
      criterionIds.add(criterion.id);
    }

    const evidenceIds = new Set<string>();
    for (const [index, evidence] of candidate.evidence.entries()) {
      if (evidenceIds.has(evidence.id)) {
        context.addIssue({
          code: "custom",
          message: "Evidence IDs must be unique.",
          path: ["evidence", index, "id"],
        });
      }
      evidenceIds.add(evidence.id);
      for (const criterionId of evidence.criterionIds) {
        if (!criterionIds.has(criterionId)) {
          context.addIssue({
            code: "custom",
            message: "Evidence must reference a known acceptance criterion.",
            path: ["evidence", index, "criterionIds"],
          });
        }
      }
    }
  });

const findingOutput = z.object({
  id: identifier,
  ruleId: identifier,
  severity: z.enum(["blocker", "major", "minor"]),
  message: z.string().min(1).max(2_000),
  file: z.string().min(1).max(500).optional(),
  line: z.number().int().positive().optional(),
});

const criterionDecisionOutput = z.object({
  criterionId: identifier,
  verdict: z.enum(["pass", "fail"]),
  rationale: z.string().min(1).max(2_000),
  evidenceIds: z.array(identifier).max(200),
});

const adversarialAttemptOutput = z.object({
  id: identifier,
  criterionId: identifier,
  scenario: z.string().min(1).max(2_000),
  outcome: z.enum(["survived", "exposed-gap"]),
  rationale: z.string().min(1).max(2_000),
});

const blockerOutput = z.object({
  gate: z.enum(["code-review", "acceptance-evals", "adversarial-review"]),
  id: identifier,
  message: z.string().min(1).max(2_000),
});

const codeReviewReport = z.object({
  summary: z.string().min(1).max(4_000),
  findings: z.array(findingOutput).max(200),
});

const acceptanceEvaluationReport = z.object({
  summary: z.string().min(1).max(4_000),
  results: z.array(criterionDecisionOutput).max(100),
});

const adversarialReviewReport = z.object({
  summary: z.string().min(1).max(4_000),
  attempts: z.array(adversarialAttemptOutput).max(200),
});

export function createAssessTaskReadiness({
  codeReviewer,
  acceptanceJudge,
  adversarialReviewer,
}: ReviewDependencies) {
  return defineCapability({
    title: "Assess task readiness",
    description:
      "Run independent code review, acceptance evaluations, and adversarial review before a task may be declared complete.",
    input,
    output: z.object({
      taskId: identifier,
      policyVersion: z.string().min(1),
      readyToComplete: z.boolean(),
      decision: z.enum(["pass", "changes-required"]),
      gates: z.object({
        codeReview: z.object({
          verdict: z.enum(["pass", "fail"]),
          summary: z.string().min(1).max(4_000),
          findings: z.array(findingOutput).max(200),
        }),
        acceptanceEvals: z.object({
          verdict: z.enum(["pass", "fail"]),
          summary: z.string().min(1).max(4_000),
          criteria: z.array(criterionDecisionOutput).min(1).max(50),
        }),
        adversarialReview: z.object({
          verdict: z.enum(["pass", "fail"]),
          summary: z.string().min(1).max(4_000),
          attempts: z.array(adversarialAttemptOutput).max(200),
        }),
      }),
      blockers: z.array(blockerOutput).max(1_500),
      nextAction: z.enum(["declare-complete", "address-blockers-and-rerun"]),
    }),
    access: "authenticated",
    timeoutMs: 120_000,
    annotations: {
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: false,
    },
    async run({ input: candidate, context }) {
      const [unparsedCodeReview, unparsedAcceptanceEvals, unparsedAdversarial] =
        await Promise.all([
          codeReviewer.review(
            structuredClone(candidate),
            standardReviewPolicy.codeReview,
            { signal: context.signal },
          ),
          acceptanceJudge.evaluate(
            structuredClone(candidate),
            standardReviewPolicy.acceptanceEvals,
            { signal: context.signal },
          ),
          adversarialReviewer.challenge(
            structuredClone(candidate),
            standardReviewPolicy.adversarialReview,
            { signal: context.signal },
          ),
        ]);
      const codeReview = codeReviewReport.parse(unparsedCodeReview);
      const acceptanceEvals = acceptanceEvaluationReport.parse(
        unparsedAcceptanceEvals,
      );
      const adversarialReview =
        adversarialReviewReport.parse(unparsedAdversarial);

      return assessReadiness(candidate, standardReviewPolicy, {
        codeReview,
        acceptanceEvals,
        adversarialReview,
      });
    },
  });
}
