import type {
  AcceptanceEvaluationReport,
  AdversarialReviewReport,
  CodeReviewReport,
  ReviewCandidate,
} from "../domain/review.js";
import type { ReviewRule } from "../domain/policy.js";

export interface ReviewerOptions {
  readonly signal: AbortSignal;
}

export interface CodeReviewer {
  review(
    candidate: ReviewCandidate,
    rules: ReadonlyArray<ReviewRule>,
    options: ReviewerOptions,
  ): Promise<CodeReviewReport>;
}

export interface AcceptanceJudge {
  evaluate(
    candidate: ReviewCandidate,
    rules: ReadonlyArray<ReviewRule>,
    options: ReviewerOptions,
  ): Promise<AcceptanceEvaluationReport>;
}

export interface AdversarialReviewer {
  challenge(
    candidate: ReviewCandidate,
    rules: ReadonlyArray<ReviewRule>,
    options: ReviewerOptions,
  ): Promise<AdversarialReviewReport>;
}

export interface ReviewDependencies {
  readonly codeReviewer: CodeReviewer;
  readonly acceptanceJudge: AcceptanceJudge;
  readonly adversarialReviewer: AdversarialReviewer;
}
