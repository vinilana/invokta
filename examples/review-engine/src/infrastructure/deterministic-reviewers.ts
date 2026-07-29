import type { ReviewDependencies } from "../application/ports.js";
import type { ReviewRule } from "../domain/policy.js";

function requireRule(rules: ReadonlyArray<ReviewRule>, ruleId: string): string {
  const rule = rules.find(({ id }) => id === ruleId);
  if (rule === undefined) {
    throw new Error(`Required review rule ${ruleId} is missing.`);
  }
  return rule.id;
}

/**
 * A deterministic local fixture for exercising the engine without a model
 * provider. It checks structured evidence and a few explicit patch markers; it
 * is not a substitute for a production code-review or judge implementation.
 */
export function createDeterministicReviewers(): ReviewDependencies {
  return {
    codeReviewer: {
      async review(candidate, rules, { signal }) {
        signal.throwIfAborted();
        const verificationRule = requireRule(rules, "CR-03");
        const maintainabilityRule = requireRule(rules, "CR-05");
        const findings = candidate.evidence
          .filter(({ passed }) => !passed)
          .map((evidence, index) => ({
            id: `FAILED-${String(index + 1)}`,
            ruleId: verificationRule,
            severity: "major" as const,
            message: `Verification evidence ${evidence.id} is reported as failing.`,
          }));

        if (
          !candidate.evidence.some(
            ({ kind, passed }) => kind === "test" && passed,
          )
        ) {
          findings.push({
            id: "MISSING-AUTOMATED-TEST",
            ruleId: verificationRule,
            severity: "major",
            message: "No passing automated test evidence was supplied.",
          });
        }

        const addedPatchLines = candidate.change.patch
          .split("\n")
          .filter((line) => line.startsWith("+") && !line.startsWith("+++"));
        if (
          addedPatchLines.some((line) =>
            /(?:TODO|FIXME|@ts-ignore|biome-ignore)/u.test(line),
          )
        ) {
          findings.push({
            id: "UNRESOLVED-BYPASS",
            ruleId: maintainabilityRule,
            severity: "major",
            message:
              "The patch adds an unresolved TODO, FIXME, or validation bypass marker.",
          });
        }

        return {
          summary:
            findings.length === 0
              ? "The deterministic checks found no blocking verification or bypass issue."
              : "The deterministic checks found completion-blocking issues.",
          findings,
        };
      },
    },

    acceptanceJudge: {
      async evaluate(candidate, rules, { signal }) {
        signal.throwIfAborted();
        requireRule(rules, "EV-01");
        requireRule(rules, "EV-02");
        requireRule(rules, "EV-04");
        const results = candidate.acceptanceCriteria.map((criterion) => {
          const evidence = candidate.evidence.filter((item) =>
            item.criterionIds.includes(criterion.id),
          );
          const passed =
            evidence.length > 0 && evidence.every((item) => item.passed);
          return {
            criterionId: criterion.id,
            verdict: passed ? ("pass" as const) : ("fail" as const),
            rationale: passed
              ? "All evidence mapped to this criterion is passing."
              : "Evidence is missing or at least one mapped check is failing.",
            evidenceIds: evidence.map(({ id }) => id),
          };
        });
        return {
          summary: results.every(({ verdict }) => verdict === "pass")
            ? "Every acceptance criterion has passing mapped evidence."
            : "At least one acceptance criterion lacks passing mapped evidence.",
          results,
        };
      },
    },

    adversarialReviewer: {
      async challenge(candidate, rules, { signal }) {
        signal.throwIfAborted();
        requireRule(rules, "AR-01");
        requireRule(rules, "AR-04");
        const attempts = candidate.acceptanceCriteria.map(
          (criterion, index) => {
            const evidence = candidate.evidence.filter(
              (item) =>
                item.kind === "adversarial-test" &&
                item.criterionIds.includes(criterion.id),
            );
            const survived =
              evidence.length > 0 && evidence.every((item) => item.passed);
            return {
              id: `ADV-${String(index + 1)}`,
              criterionId: criterion.id,
              scenario: `Attempt to falsify: ${criterion.statement}`,
              outcome: survived
                ? ("survived" as const)
                : ("exposed-gap" as const),
              rationale: survived
                ? "Passing adversarial-test evidence is mapped to this criterion."
                : "No passing adversarial-test evidence is mapped to this criterion.",
            };
          },
        );
        return {
          summary: attempts.every(({ outcome }) => outcome === "survived")
            ? "Every acceptance criterion survived a recorded counterexample."
            : "At least one acceptance criterion has no passing adversarial challenge.",
          attempts,
        };
      },
    },
  };
}
