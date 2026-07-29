import type {
  AcceptanceEvaluation,
  AcceptanceEvaluationReport,
  AdversarialAttempt,
  AdversarialReviewReport,
  CodeReviewFinding,
  CodeReviewReport,
  ReviewCandidate,
} from "./review.js";
import type { ReviewRule } from "./policy.js";

export type ReviewGate =
  | "code-review"
  | "acceptance-evals"
  | "adversarial-review";

export interface CompletionBlocker {
  readonly gate: ReviewGate;
  readonly id: string;
  readonly message: string;
}

export interface CriterionDecision {
  readonly criterionId: string;
  readonly verdict: "pass" | "fail";
  readonly rationale: string;
  readonly evidenceIds: string[];
}

export interface ReadinessAssessment {
  readonly taskId: string;
  readonly policyVersion: string;
  readonly readyToComplete: boolean;
  readonly decision: "pass" | "changes-required";
  readonly gates: {
    readonly codeReview: {
      readonly verdict: "pass" | "fail";
      readonly summary: string;
      readonly findings: CodeReviewFinding[];
    };
    readonly acceptanceEvals: {
      readonly verdict: "pass" | "fail";
      readonly summary: string;
      readonly criteria: CriterionDecision[];
    };
    readonly adversarialReview: {
      readonly verdict: "pass" | "fail";
      readonly summary: string;
      readonly attempts: AdversarialAttempt[];
    };
  };
  readonly blockers: CompletionBlocker[];
  readonly nextAction: "declare-complete" | "address-blockers-and-rerun";
}

interface ReviewPolicy {
  readonly version: string;
  readonly codeReview: ReadonlyArray<ReviewRule>;
}

function evidenceIds(results: ReadonlyArray<AcceptanceEvaluation>): string[] {
  return [...new Set(results.flatMap((result) => result.evidenceIds))].slice(
    0,
    200,
  );
}

function criterionDecision(
  candidate: ReviewCandidate,
  criterionId: string,
  results: ReadonlyArray<AcceptanceEvaluation>,
): {
  readonly decision: CriterionDecision;
  readonly blocker?: CompletionBlocker;
} {
  if (results.length !== 1) {
    const rationale =
      results.length === 0
        ? "The acceptance judge did not return a verdict for this criterion."
        : "The acceptance judge returned more than one verdict for this criterion.";
    return {
      decision: {
        criterionId,
        verdict: "fail",
        rationale,
        evidenceIds: evidenceIds(results),
      },
      blocker: {
        gate: "acceptance-evals",
        id: criterionId,
        message: rationale,
      },
    };
  }

  const [result] = results;
  if (result === undefined) {
    throw new Error("The acceptance result count changed unexpectedly.");
  }
  if (result.verdict === "fail") {
    return {
      decision: { ...result, evidenceIds: result.evidenceIds.slice() },
      blocker: {
        gate: "acceptance-evals",
        id: criterionId,
        message: result.rationale,
      },
    };
  }

  const mappedEvidence = candidate.evidence.filter((evidence) =>
    evidence.criterionIds.includes(criterionId),
  );
  const citedEvidence = result.evidenceIds.map((id) =>
    candidate.evidence.find((evidence) => evidence.id === id),
  );
  const invalidEvidence =
    result.evidenceIds.length === 0 ||
    new Set(result.evidenceIds).size !== result.evidenceIds.length ||
    citedEvidence.some(
      (evidence) =>
        evidence === undefined ||
        !evidence.passed ||
        !evidence.criterionIds.includes(criterionId),
    ) ||
    mappedEvidence.some((evidence) => !evidence.passed);

  if (invalidEvidence) {
    const rationale =
      "The passing verdict is not supported by unique, passed evidence mapped to this criterion.";
    return {
      decision: {
        criterionId,
        verdict: "fail",
        rationale,
        evidenceIds: result.evidenceIds.slice(),
      },
      blocker: {
        gate: "acceptance-evals",
        id: criterionId,
        message: rationale,
      },
    };
  }

  return {
    decision: { ...result, evidenceIds: result.evidenceIds.slice() },
  };
}

export function assessReadiness(
  candidate: ReviewCandidate,
  policy: ReviewPolicy,
  reports: {
    readonly codeReview: CodeReviewReport;
    readonly acceptanceEvals: AcceptanceEvaluationReport;
    readonly adversarialReview: AdversarialReviewReport;
  },
): ReadinessAssessment {
  const blockers: CompletionBlocker[] = [];
  const codeRuleIds = new Set(policy.codeReview.map(({ id }) => id));
  const codeFindingIds = new Set<string>();

  for (const finding of reports.codeReview.findings) {
    if (codeFindingIds.has(finding.id)) {
      blockers.push({
        gate: "code-review",
        id: finding.id,
        message: "The code reviewer returned a duplicate finding ID.",
      });
    }
    codeFindingIds.add(finding.id);
    if (!codeRuleIds.has(finding.ruleId)) {
      blockers.push({
        gate: "code-review",
        id: finding.id,
        message: "The code review finding references an unknown policy rule.",
      });
    }
    if (finding.severity !== "minor") {
      blockers.push({
        gate: "code-review",
        id: finding.id,
        message: finding.message,
      });
    }
  }

  const criteria = candidate.acceptanceCriteria.map((criterion) =>
    criterionDecision(
      candidate,
      criterion.id,
      reports.acceptanceEvals.results.filter(
        (result) => result.criterionId === criterion.id,
      ),
    ),
  );
  for (const result of criteria) {
    if (result.blocker !== undefined) blockers.push(result.blocker);
  }

  const knownCriterionIds = new Set(
    candidate.acceptanceCriteria.map(({ id }) => id),
  );
  for (const result of reports.acceptanceEvals.results) {
    if (!knownCriterionIds.has(result.criterionId)) {
      blockers.push({
        gate: "acceptance-evals",
        id: result.criterionId,
        message:
          "The acceptance judge returned a verdict for an unknown criterion.",
      });
    }
  }

  const attemptIds = new Set<string>();
  for (const attempt of reports.adversarialReview.attempts) {
    if (attemptIds.has(attempt.id)) {
      blockers.push({
        gate: "adversarial-review",
        id: attempt.id,
        message: "The adversarial reviewer returned a duplicate attempt ID.",
      });
    }
    attemptIds.add(attempt.id);
    if (!knownCriterionIds.has(attempt.criterionId)) {
      blockers.push({
        gate: "adversarial-review",
        id: attempt.id,
        message:
          "The adversarial reviewer challenged an unknown acceptance criterion.",
      });
    }
    if (attempt.outcome === "exposed-gap") {
      blockers.push({
        gate: "adversarial-review",
        id: attempt.id,
        message: attempt.rationale,
      });
    }
  }
  for (const criterion of candidate.acceptanceCriteria) {
    if (
      !reports.adversarialReview.attempts.some(
        (attempt) => attempt.criterionId === criterion.id,
      )
    ) {
      blockers.push({
        gate: "adversarial-review",
        id: criterion.id,
        message:
          "No adversarial counterexample was attempted for this criterion.",
      });
    }
  }

  const codeReviewFailed = blockers.some(({ gate }) => gate === "code-review");
  const acceptanceEvalsFailed = blockers.some(
    ({ gate }) => gate === "acceptance-evals",
  );
  const adversarialReviewFailed = blockers.some(
    ({ gate }) => gate === "adversarial-review",
  );
  const readyToComplete = blockers.length === 0;

  return {
    taskId: candidate.taskId,
    policyVersion: policy.version,
    readyToComplete,
    decision: readyToComplete ? "pass" : "changes-required",
    gates: {
      codeReview: {
        verdict: codeReviewFailed ? "fail" : "pass",
        summary: reports.codeReview.summary,
        findings: reports.codeReview.findings.map((finding) => ({
          id: finding.id,
          ruleId: finding.ruleId,
          severity: finding.severity,
          message: finding.message,
          ...(finding.file === undefined ? {} : { file: finding.file }),
          ...(finding.line === undefined ? {} : { line: finding.line }),
        })),
      },
      acceptanceEvals: {
        verdict: acceptanceEvalsFailed ? "fail" : "pass",
        summary: reports.acceptanceEvals.summary,
        criteria: criteria.map(({ decision }) => decision),
      },
      adversarialReview: {
        verdict: adversarialReviewFailed ? "fail" : "pass",
        summary: reports.adversarialReview.summary,
        attempts: reports.adversarialReview.attempts.map((attempt) => ({
          ...attempt,
        })),
      },
    },
    blockers,
    nextAction: readyToComplete
      ? "declare-complete"
      : "address-blockers-and-rerun",
  };
}
