import type { EngineError, Principal } from "@invokta/core";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import type {
  AcceptanceJudge,
  AdversarialReviewer,
  CodeReviewer,
  ReviewDependencies,
} from "../src/application/ports.js";
import type {
  AcceptanceEvaluationReport,
  AdversarialReviewReport,
  CodeReviewReport,
  ReviewCandidate,
} from "../src/domain/review.js";
import { createReviewEngine } from "../src/engine.js";
import { createDeterministicReviewers } from "../src/infrastructure/deterministic-reviewers.js";

const principal: Principal = { id: "agent:delivery-reviewer" };
const invocation = { source: "direct", principal } as const;

const candidate: ReviewCandidate = {
  taskId: "TASK-42",
  summary: "Reject task completion until every review gate passes.",
  acceptanceCriteria: [
    {
      id: "AC-1",
      statement: "A blocking code review finding prevents completion.",
    },
    {
      id: "AC-2",
      statement: "Every acceptance criterion has passing evidence.",
    },
  ],
  change: {
    summary: "Add a fail-closed readiness decision.",
    files: ["src/readiness.ts", "test/readiness.test.ts"],
    patch: "+export const ready = blockers.length === 0;\n",
  },
  evidence: [
    {
      id: "E-AC1",
      kind: "test",
      criterionIds: ["AC-1"],
      passed: true,
      command: "vitest run readiness.test.ts",
      summary: "The blocking-finding test passed.",
    },
    {
      id: "E-AC2",
      kind: "test",
      criterionIds: ["AC-2"],
      passed: true,
      command: "vitest run readiness.test.ts",
      summary: "The criterion coverage test passed.",
    },
    {
      id: "E-ADV1",
      kind: "adversarial-test",
      criterionIds: ["AC-1"],
      passed: true,
      command: "vitest run readiness.adversarial.test.ts",
      summary: "A major finding was injected and blocked completion.",
    },
    {
      id: "E-ADV2",
      kind: "adversarial-test",
      criterionIds: ["AC-2"],
      passed: true,
      command: "vitest run readiness.adversarial.test.ts",
      summary: "Missing evidence was injected and blocked completion.",
    },
  ],
};

const passingCodeReview: CodeReviewReport = {
  summary: "No blocking or major findings.",
  findings: [],
};

const passingAcceptanceEvals: AcceptanceEvaluationReport = {
  summary: "Every criterion passed with mapped evidence.",
  results: [
    {
      criterionId: "AC-1",
      verdict: "pass",
      rationale: "The blocking behavior is covered.",
      evidenceIds: ["E-AC1"],
    },
    {
      criterionId: "AC-2",
      verdict: "pass",
      rationale: "The coverage behavior is covered.",
      evidenceIds: ["E-AC2"],
    },
  ],
};

const passingAdversarialReview: AdversarialReviewReport = {
  summary: "Both criteria survived a counterexample.",
  attempts: [
    {
      id: "ADV-1",
      criterionId: "AC-1",
      scenario: "Inject a major code review finding.",
      outcome: "survived",
      rationale: "Completion remained blocked.",
    },
    {
      id: "ADV-2",
      criterionId: "AC-2",
      scenario: "Remove all evidence for one criterion.",
      outcome: "survived",
      rationale: "Completion remained blocked.",
    },
  ],
};

function requiredItem<T>(items: ReadonlyArray<T>, index: number): T {
  const item = items[index];
  if (item === undefined)
    throw new Error("Required test fixture item is missing.");
  return item;
}

function createDependencies(
  overrides: {
    readonly codeReview?: CodeReviewReport;
    readonly acceptanceEvals?: AcceptanceEvaluationReport;
    readonly adversarialReview?: AdversarialReviewReport;
  } = {},
): ReviewDependencies {
  return {
    codeReviewer: {
      review: vi.fn(async () => overrides.codeReview ?? passingCodeReview),
    },
    acceptanceJudge: {
      evaluate: vi.fn(
        async () => overrides.acceptanceEvals ?? passingAcceptanceEvals,
      ),
    },
    adversarialReviewer: {
      challenge: vi.fn(
        async () => overrides.adversarialReview ?? passingAdversarialReview,
      ),
    },
  };
}

describe("the review engine example", () => {
  it("allows completion only after all three independent gates pass", async () => {
    const dependencies = createDependencies();
    const engine = createReviewEngine(dependencies);

    const result = await engine.invoke(
      "review.assess-task-readiness",
      candidate,
      invocation,
    );

    expectTypeOf(result.readyToComplete).toEqualTypeOf<boolean>();
    expect(result).toMatchObject({
      taskId: "TASK-42",
      policyVersion: "2026-07-28",
      readyToComplete: true,
      decision: "pass",
      gates: {
        codeReview: { verdict: "pass" },
        acceptanceEvals: { verdict: "pass" },
        adversarialReview: { verdict: "pass" },
      },
      blockers: [],
      nextAction: "declare-complete",
    });

    expect(dependencies.codeReviewer.review).toHaveBeenCalledOnce();
    expect(dependencies.acceptanceJudge.evaluate).toHaveBeenCalledOnce();
    expect(dependencies.adversarialReviewer.challenge).toHaveBeenCalledOnce();
    expect(
      vi
        .mocked(dependencies.codeReviewer.review)
        .mock.calls[0]?.[1].map(({ id }) => id),
    ).toEqual(["CR-01", "CR-02", "CR-03", "CR-04", "CR-05"]);
    expect(
      vi
        .mocked(dependencies.acceptanceJudge.evaluate)
        .mock.calls[0]?.[1].map(({ id }) => id),
    ).toEqual(["EV-01", "EV-02", "EV-03", "EV-04"]);
    expect(
      vi
        .mocked(dependencies.adversarialReviewer.challenge)
        .mock.calls[0]?.[1].map(({ id }) => id),
    ).toEqual(["AR-01", "AR-02", "AR-03", "AR-04"]);
  });

  it("blocks completion for blocker and major code findings but not minor findings", async () => {
    const major = createReviewEngine(
      createDependencies({
        codeReview: {
          summary: "A regression was found.",
          findings: [
            {
              id: "F-1",
              ruleId: "CR-01",
              severity: "major",
              message: "The error path returns success.",
              file: "src/readiness.ts",
              line: 8,
            },
          ],
        },
      }),
    );

    await expect(
      major.invoke("review.assess-task-readiness", candidate, invocation),
    ).resolves.toMatchObject({
      readyToComplete: false,
      decision: "changes-required",
      gates: { codeReview: { verdict: "fail" } },
      blockers: [
        {
          gate: "code-review",
          id: "F-1",
          message: "The error path returns success.",
        },
      ],
      nextAction: "address-blockers-and-rerun",
    });

    const minor = createReviewEngine(
      createDependencies({
        codeReview: {
          summary: "Only a non-blocking naming suggestion remains.",
          findings: [
            {
              id: "F-2",
              ruleId: "CR-05",
              severity: "minor",
              message: "Consider a more precise local variable name.",
            },
          ],
        },
      }),
    );
    await expect(
      minor.invoke("review.assess-task-readiness", candidate, invocation),
    ).resolves.toMatchObject({
      readyToComplete: true,
      gates: { codeReview: { verdict: "pass" } },
    });
  });

  it("fails closed when an acceptance verdict is missing or duplicated", async () => {
    const engine = createReviewEngine(
      createDependencies({
        acceptanceEvals: {
          summary: "The judge returned incomplete and duplicated coverage.",
          results: [
            requiredItem(passingAcceptanceEvals.results, 0),
            { ...requiredItem(passingAcceptanceEvals.results, 0) },
          ],
        },
      }),
    );

    const result = await engine.invoke(
      "review.assess-task-readiness",
      candidate,
      invocation,
    );

    expect(result).toMatchObject({
      readyToComplete: false,
      gates: {
        acceptanceEvals: {
          verdict: "fail",
          criteria: [
            { criterionId: "AC-1", verdict: "fail" },
            { criterionId: "AC-2", verdict: "fail" },
          ],
        },
      },
    });
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gate: "acceptance-evals",
          id: "AC-1",
        }),
        expect.objectContaining({
          gate: "acceptance-evals",
          id: "AC-2",
        }),
      ]),
    );
  });

  it("bounds evidence echoed from a maximally duplicated judge response", async () => {
    const duplicatedResults = Array.from({ length: 100 }, (_, resultIndex) => ({
      criterionId: "AC-1",
      verdict: "pass" as const,
      rationale: "A duplicated verdict must fail closed.",
      evidenceIds: Array.from(
        { length: 200 },
        (_, evidenceIndex) =>
          `E-${String(resultIndex)}-${String(evidenceIndex)}`,
      ),
    }));
    const engine = createReviewEngine(
      createDependencies({
        acceptanceEvals: {
          summary:
            "The judge returned the maximum number of duplicate verdicts.",
          results: duplicatedResults,
        },
      }),
    );

    const result = await engine.invoke(
      "review.assess-task-readiness",
      candidate,
      invocation,
    );

    expect(result).toMatchObject({
      readyToComplete: false,
      gates: { acceptanceEvals: { verdict: "fail" } },
      nextAction: "address-blockers-and-rerun",
    });
    expect(result.gates.acceptanceEvals.criteria[0]?.evidenceIds).toHaveLength(
      200,
    );
  });

  it("rejects a passing acceptance verdict that cites invalid evidence", async () => {
    const engine = createReviewEngine(
      createDependencies({
        acceptanceEvals: {
          summary: "One verdict cites evidence for a different criterion.",
          results: [
            {
              ...requiredItem(passingAcceptanceEvals.results, 0),
              evidenceIds: ["E-AC2"],
            },
            requiredItem(passingAcceptanceEvals.results, 1),
          ],
        },
      }),
    );

    const result = await engine.invoke(
      "review.assess-task-readiness",
      candidate,
      invocation,
    );
    expect(result).toMatchObject({
      readyToComplete: false,
      gates: {
        acceptanceEvals: {
          verdict: "fail",
        },
      },
      blockers: [
        expect.objectContaining({
          gate: "acceptance-evals",
          id: "AC-1",
        }),
      ],
    });
    expect(result.gates.acceptanceEvals.criteria).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ criterionId: "AC-1", verdict: "fail" }),
      ]),
    );
  });

  it("blocks exposed gaps, missing challenges, and challenges for unknown criteria", async () => {
    const engine = createReviewEngine(
      createDependencies({
        adversarialReview: {
          summary: "The adversarial reviewer exposed incomplete coverage.",
          attempts: [
            {
              id: "ADV-GAP",
              criterionId: "AC-1",
              scenario: "Return success after a major finding.",
              outcome: "exposed-gap",
              rationale: "The candidate incorrectly allowed completion.",
            },
            {
              id: "ADV-UNKNOWN",
              criterionId: "AC-404",
              scenario: "Challenge a criterion that does not exist.",
              outcome: "survived",
              rationale: "The attempt cannot establish required coverage.",
            },
          ],
        },
      }),
    );

    const result = await engine.invoke(
      "review.assess-task-readiness",
      candidate,
      invocation,
    );
    expect(result).toMatchObject({
      readyToComplete: false,
      gates: { adversarialReview: { verdict: "fail" } },
    });
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        {
          gate: "adversarial-review",
          id: "ADV-GAP",
          message: "The candidate incorrectly allowed completion.",
        },
        expect.objectContaining({
          gate: "adversarial-review",
          id: "AC-2",
        }),
        expect.objectContaining({
          gate: "adversarial-review",
          id: "ADV-UNKNOWN",
        }),
      ]),
    );
  });

  it("gives each reviewer an independent candidate snapshot and the invocation signal", async () => {
    const candidates: ReviewCandidate[] = [];
    const signals: AbortSignal[] = [];
    const codeReviewer: CodeReviewer = {
      async review(received, _rules, options) {
        candidates.push(received);
        signals.push(options.signal);
        (received.change.files as string[]).push("mutated-by-code-review.ts");
        return passingCodeReview;
      },
    };
    const acceptanceJudge: AcceptanceJudge = {
      async evaluate(received, _rules, options) {
        candidates.push(received);
        signals.push(options.signal);
        return passingAcceptanceEvals;
      },
    };
    const adversarialReviewer: AdversarialReviewer = {
      async challenge(received, _rules, options) {
        candidates.push(received);
        signals.push(options.signal);
        return passingAdversarialReview;
      },
    };
    const controller = new AbortController();
    const engine = createReviewEngine({
      codeReviewer,
      acceptanceJudge,
      adversarialReviewer,
    });

    await engine.invoke("review.assess-task-readiness", candidate, {
      ...invocation,
      signal: controller.signal,
    });

    expect(candidates).toHaveLength(3);
    expect(new Set(candidates).size).toBe(3);
    expect(candidates[1]?.change.files).toEqual(candidate.change.files);
    expect(candidates[2]?.change.files).toEqual(candidate.change.files);
    expect(signals).toHaveLength(3);
    expect(new Set(signals).size).toBe(1);
  });

  it("propagates cancellation to reviewers and returns no readiness decision", async () => {
    let reviewerSignal: AbortSignal | undefined;
    const dependencies = createDependencies();
    dependencies.codeReviewer.review = vi.fn(
      async (_candidate, _rules, { signal }) => {
        reviewerSignal = signal;
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
        return passingCodeReview;
      },
    );
    const controller = new AbortController();
    const engine = createReviewEngine(dependencies);
    const invoked = engine.invoke("review.assess-task-readiness", candidate, {
      ...invocation,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(reviewerSignal).toBeDefined());
    controller.abort(new Error("The agent stopped the review."));

    await expect(invoked).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("validates identifiers, cross-references, and payload limits before review", async () => {
    const dependencies = createDependencies();
    const engine = createReviewEngine(dependencies);

    await expect(
      engine.invoke(
        "review.assess-task-readiness",
        {
          ...candidate,
          acceptanceCriteria: [
            requiredItem(candidate.acceptanceCriteria, 0),
            { ...requiredItem(candidate.acceptanceCriteria, 0) },
          ],
        },
        invocation,
      ),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });

    await expect(
      engine.invoke(
        "review.assess-task-readiness",
        {
          ...candidate,
          evidence: [
            {
              ...requiredItem(candidate.evidence, 0),
              criterionIds: ["AC-404"],
            },
          ],
        },
        invocation,
      ),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });

    await expect(
      engine.invoke(
        "review.assess-task-readiness",
        {
          ...candidate,
          change: { ...candidate.change, patch: "x".repeat(200_001) },
        },
        invocation,
      ),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    expect(dependencies.codeReviewer.review).not.toHaveBeenCalled();
  });

  it("requires an authenticated principal before any reviewer runs", async () => {
    const dependencies = createDependencies();
    const engine = createReviewEngine(dependencies);

    await expect(
      engine.invoke("review.assess-task-readiness", candidate, {
        source: "direct",
        principal: null,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<EngineError>>({
        code: "UNAUTHENTICATED",
      }),
    );
    expect(dependencies.codeReviewer.review).not.toHaveBeenCalled();
    expect(dependencies.acceptanceJudge.evaluate).not.toHaveBeenCalled();
    expect(dependencies.adversarialReviewer.challenge).not.toHaveBeenCalled();
  });

  it("ships deterministic reviewers that require passing verification and adversarial evidence", async () => {
    const engine = createReviewEngine(createDeterministicReviewers());

    await expect(
      engine.invoke("review.assess-task-readiness", candidate, invocation),
    ).resolves.toMatchObject({
      readyToComplete: true,
      decision: "pass",
    });

    const withoutSecondChallenge = {
      ...candidate,
      evidence: candidate.evidence.filter(({ id }) => id !== "E-ADV2"),
    };
    await expect(
      engine.invoke(
        "review.assess-task-readiness",
        withoutSecondChallenge,
        invocation,
      ),
    ).resolves.toMatchObject({
      readyToComplete: false,
      gates: {
        codeReview: { verdict: "pass" },
        acceptanceEvals: { verdict: "pass" },
        adversarialReview: { verdict: "fail" },
      },
      blockers: [
        expect.objectContaining({
          gate: "adversarial-review",
          id: "ADV-2",
        }),
      ],
    });

    const failedVerification = {
      ...candidate,
      evidence: candidate.evidence.map((evidence) =>
        evidence.id === "E-AC1" ? { ...evidence, passed: false } : evidence,
      ),
    };
    await expect(
      engine.invoke(
        "review.assess-task-readiness",
        failedVerification,
        invocation,
      ),
    ).resolves.toMatchObject({
      readyToComplete: false,
      gates: {
        codeReview: { verdict: "fail" },
        acceptanceEvals: { verdict: "fail" },
      },
    });

    await expect(
      engine.invoke(
        "review.assess-task-readiness",
        {
          ...candidate,
          change: {
            ...candidate.change,
            patch: "+// TODO: bypass this check before release\n",
          },
        },
        invocation,
      ),
    ).resolves.toMatchObject({
      readyToComplete: false,
      gates: { codeReview: { verdict: "fail" } },
      blockers: [
        expect.objectContaining({
          gate: "code-review",
          id: "UNRESOLVED-BYPASS",
        }),
      ],
    });
  });

  it("publishes one bounded, read-only readiness capability", () => {
    const engine = createReviewEngine(createDependencies());

    expect(engine.list().map(({ id }) => id)).toEqual([
      "review.assess-task-readiness",
    ]);
    expect(engine.describe("review.assess-task-readiness")).toMatchObject({
      title: "Assess task readiness",
      timeoutMs: 120_000,
      annotations: {
        readOnly: true,
        destructive: false,
        idempotent: true,
        openWorld: false,
      },
      inputSchema: {
        type: "object",
        required: [
          "taskId",
          "summary",
          "acceptanceCriteria",
          "change",
          "evidence",
        ],
      },
    });
  });
});
