export type EvidenceKind =
  | "test"
  | "adversarial-test"
  | "typecheck"
  | "lint"
  | "build"
  | "manual-inspection";

export interface AcceptanceCriterion {
  readonly id: string;
  readonly statement: string;
}

export interface ReviewEvidence {
  readonly id: string;
  readonly kind: EvidenceKind;
  readonly criterionIds: string[];
  readonly passed: boolean;
  readonly command: string | null;
  readonly summary: string;
}

export interface ReviewCandidate {
  readonly taskId: string;
  readonly summary: string;
  readonly acceptanceCriteria: AcceptanceCriterion[];
  readonly change: {
    readonly summary: string;
    readonly files: string[];
    readonly patch: string;
  };
  readonly evidence: ReviewEvidence[];
}

export type FindingSeverity = "blocker" | "major" | "minor";

export interface CodeReviewFinding {
  readonly id: string;
  readonly ruleId: string;
  readonly severity: FindingSeverity;
  readonly message: string;
  readonly file?: string | undefined;
  readonly line?: number | undefined;
}

export interface CodeReviewReport {
  readonly summary: string;
  readonly findings: ReadonlyArray<CodeReviewFinding>;
}

export interface AcceptanceEvaluation {
  readonly criterionId: string;
  readonly verdict: "pass" | "fail";
  readonly rationale: string;
  readonly evidenceIds: ReadonlyArray<string>;
}

export interface AcceptanceEvaluationReport {
  readonly summary: string;
  readonly results: ReadonlyArray<AcceptanceEvaluation>;
}

export interface AdversarialAttempt {
  readonly id: string;
  readonly criterionId: string;
  readonly scenario: string;
  readonly outcome: "survived" | "exposed-gap";
  readonly rationale: string;
}

export interface AdversarialReviewReport {
  readonly summary: string;
  readonly attempts: ReadonlyArray<AdversarialAttempt>;
}
