export type WorkflowStage =
  | "drafted"
  | "planned"
  | "tasked"
  | "implementing"
  | "delivered";

export interface SpecificationDraft {
  readonly summary: string;
  readonly requirements: ReadonlyArray<string>;
  readonly acceptanceCriteria: ReadonlyArray<string>;
}

export interface ImplementationPlan {
  readonly approach: string;
  readonly steps: ReadonlyArray<string>;
  readonly risks: ReadonlyArray<string>;
}

export interface WorkflowTask {
  readonly id: string;
  readonly title: string;
  readonly status: "pending" | "completed";
  readonly evidence: string | null;
}

export interface SpecificationRecord {
  readonly specId: string;
  readonly stage: WorkflowStage;
  readonly revision: number;
  readonly specification: SpecificationDraft;
  readonly plan: ImplementationPlan | null;
  readonly tasks: ReadonlyArray<WorkflowTask>;
}
