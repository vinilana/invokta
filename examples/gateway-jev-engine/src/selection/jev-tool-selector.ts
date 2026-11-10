import type { DiscoveryRanker } from "@invokta/gateway";

import type {
  ToolCandidate,
  ToolNeed,
  ToolNeedJudge,
} from "../application/ports.js";

export interface JevToolSelectorOptions {
  readonly judge: ToolNeedJudge;
  /** Minimum probability for a tool to count as needed. Defaults to 0.5. */
  readonly threshold?: number;
  /** Most tools returned for one task. Defaults to 8, at most 20. */
  readonly maxTools?: number;
}

export interface JevToolSelector {
  /** The tools the task needs, most likely first; empty when none is. */
  select(
    task: string,
    candidates: ReadonlyArray<ToolCandidate>,
    options: { readonly signal: AbortSignal },
  ): Promise<ReadonlyArray<ToolNeed>>;
  /**
   * The same decision as the `rank` port of `createDiscovery`, so
   * `search-tools` returns exactly the needed tools. The gateway only passes
   * tools visible to the caller and drops any other ID.
   */
  readonly ranker: DiscoveryRanker;
}

/**
 * Turns independent per-tool judgments into a selection. An empty result is
 * an abstention: no tool is likely enough to be needed, and the caller should
 * rephrase the task rather than receive a guess.
 */
export function createJevToolSelector(
  options: JevToolSelectorOptions,
): JevToolSelector {
  const threshold = options.threshold ?? 0.5;
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) {
    throw new TypeError("threshold must be between 0 and 1, exclusive.");
  }
  const maxTools = options.maxTools ?? 8;
  if (!Number.isInteger(maxTools) || maxTools < 1 || maxTools > 20) {
    throw new TypeError("maxTools must be an integer from 1 through 20.");
  }
  const { judge } = options;

  const select: JevToolSelector["select"] = async (task, candidates, call) => {
    const needs = await judge.judge(task, candidates, call);
    return needs
      .filter((need) => need.probability >= threshold)
      .sort(
        (left, right) =>
          right.probability - left.probability || (left.id < right.id ? -1 : 1),
      )
      .slice(0, maxTools);
  };

  const ranker: DiscoveryRanker = async (query, candidates, { signal }) =>
    (await select(query, candidates, { signal })).map((need) => need.id);

  return Object.freeze({
    select,
    ranker,
  });
}
