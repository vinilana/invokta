import type { SpecificationAuthor } from "../application/ports.js";

function sentences(intent: string): ReadonlyArray<string> {
  const parts = intent
    .split(/[.;]/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length === 0 ? [intent.trim()] : parts;
}

function lowerFirst(text: string): string {
  return text.length === 0
    ? text
    : `${text[0]?.toLowerCase() ?? ""}${text.slice(1)}`;
}

/**
 * Deterministic authoring adapter. It keeps the example runnable without a
 * model provider; replace it with a prompt-and-model implementation that honors
 * the supplied `AbortSignal`.
 */
export function createTemplateSpecificationAuthor(): SpecificationAuthor {
  return {
    async draftSpecification({ intent }, { signal }) {
      signal.throwIfAborted();
      const requirements = sentences(intent).map(
        (part) => `The system must ${lowerFirst(part)}.`,
      );
      return {
        summary: `Deliver: ${lowerFirst(sentences(intent)[0] ?? intent)}.`,
        requirements,
        acceptanceCriteria: requirements.map(
          (_requirement, index) =>
            `An automated test proves requirement ${String(index + 1)}.`,
        ),
      };
    },

    async draftPlan({ specification }, { signal }) {
      signal.throwIfAborted();
      return {
        approach:
          "Implement each requirement behind the published capability contract, one vertical slice at a time.",
        steps: specification.requirements.flatMap((_requirement, index) => [
          `Write the failing test for requirement ${String(index + 1)}.`,
          `Implement requirement ${String(index + 1)} until the test passes.`,
        ]),
        risks: [
          "The deterministic author is a placeholder for a model-backed implementation.",
        ],
      };
    },

    async draftTasks({ specification }, { signal }) {
      signal.throwIfAborted();
      return [
        ...specification.requirements.map(
          (_requirement, index) =>
            `Implement requirement ${String(index + 1)}.`,
        ),
        "Verify every acceptance criterion.",
      ];
    },
  };
}
