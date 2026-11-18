/** One tool the caller may use, as the gateway's discovery describes it. */
export interface ToolCandidate {
  readonly id: string;
  readonly title?: string;
  readonly description: string;
}

/** How likely one tool is to be needed for the task, from zero to one. */
export interface ToolNeed {
  readonly id: string;
  readonly probability: number;
}

/**
 * Engine-owned port: judges, independently for every candidate, whether the
 * task needs that tool. The TypeSafe Jev connector implements it; tests use a
 * deterministic stand-in.
 */
export interface ToolNeedJudge {
  judge(
    task: string,
    candidates: ReadonlyArray<ToolCandidate>,
    options: { readonly signal: AbortSignal },
  ): Promise<ReadonlyArray<ToolNeed>>;
}
