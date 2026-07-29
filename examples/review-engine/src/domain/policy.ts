export interface ReviewRule {
  readonly id: string;
  readonly description: string;
}

function frozenRules(
  rules: ReadonlyArray<ReviewRule>,
): ReadonlyArray<ReviewRule> {
  return Object.freeze(rules.map((rule) => Object.freeze({ ...rule })));
}

export const standardReviewPolicy = Object.freeze({
  version: "2026-07-28",
  codeReview: frozenRules([
    {
      id: "CR-01",
      description:
        "Find correctness defects and regressions relative to the task and its acceptance criteria.",
    },
    {
      id: "CR-02",
      description:
        "Check public contracts, compatibility, architecture boundaries, and repository instructions.",
    },
    {
      id: "CR-03",
      description:
        "Require focused verification for changed behavior and reject known failing checks.",
    },
    {
      id: "CR-04",
      description:
        "Inspect relevant security, authorization, data handling, cancellation, concurrency, and resource limits.",
    },
    {
      id: "CR-05",
      description:
        "Reject unrelated scope, unresolved bypasses, speculative abstractions, and maintainability regressions.",
    },
  ]),
  acceptanceEvals: frozenRules([
    {
      id: "EV-01",
      description:
        "Return exactly one binary verdict for every acceptance criterion and no verdict for an unknown criterion.",
    },
    {
      id: "EV-02",
      description:
        "A passing verdict must cite passed evidence that is explicitly mapped to the same criterion.",
    },
    {
      id: "EV-03",
      description:
        "Judge observable acceptance outcomes instead of implementation-only claims or confidence statements.",
    },
    {
      id: "EV-04",
      description:
        "Fail closed when evidence is missing, conflicting, ambiguous, or cannot be reproduced.",
    },
  ]),
  adversarialReview: frozenRules([
    {
      id: "AR-01",
      description:
        "Attempt at least one concrete counterexample against every acceptance criterion.",
    },
    {
      id: "AR-02",
      description:
        "Probe relevant invalid inputs, boundaries, failures, authorization, cancellation, and concurrency.",
    },
    {
      id: "AR-03",
      description:
        "Challenge the candidate independently instead of trusting prior review or evaluation claims.",
    },
    {
      id: "AR-04",
      description:
        "Treat every exposed gap or missing criterion challenge as completion-blocking.",
    },
  ]),
});
