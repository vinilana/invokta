import type {
  ImplementationPlan,
  SpecificationDraft,
  SpecificationRecord,
  WorkflowStage,
  WorkflowTask,
} from "./specification.js";

export type WorkflowTransition = "plan" | "break-down" | "complete-task";

/**
 * The spec-driven order is a domain rule, not a framework feature. Version 0.1
 * has no workflow engine: each capability is one invocation, and these stage
 * guards are what keep the steps in order across processes and channels.
 */
const stagesAllowingTransition: Readonly<
  Record<WorkflowTransition, ReadonlyArray<WorkflowStage>>
> = Object.freeze({
  plan: Object.freeze(["drafted"] as const),
  "break-down": Object.freeze(["planned"] as const),
  "complete-task": Object.freeze(["tasked", "implementing"] as const),
});

export function stagesFor(
  transition: WorkflowTransition,
): ReadonlyArray<WorkflowStage> {
  return stagesAllowingTransition[transition];
}

export function allowsTransition(
  stage: WorkflowStage,
  transition: WorkflowTransition,
): boolean {
  return stagesAllowingTransition[transition].includes(stage);
}

export function nextCapability(record: SpecificationRecord): string | null {
  switch (record.stage) {
    case "drafted":
      return "spec.plan-implementation";
    case "planned":
      return "spec.break-down-tasks";
    case "tasked":
    case "implementing":
      return "spec.complete-task";
    case "delivered":
      return null;
  }
}

export function draftRecord(
  specId: string,
  specification: SpecificationDraft,
): SpecificationRecord {
  return {
    specId,
    stage: "drafted",
    revision: 1,
    specification,
    plan: null,
    tasks: [],
  };
}

export function withPlan(
  record: SpecificationRecord,
  plan: ImplementationPlan,
): SpecificationRecord {
  return {
    ...record,
    stage: "planned",
    revision: record.revision + 1,
    plan,
  };
}

export function withTasks(
  record: SpecificationRecord,
  titles: ReadonlyArray<string>,
): SpecificationRecord {
  return {
    ...record,
    stage: "tasked",
    revision: record.revision + 1,
    tasks: titles.map((title, index) => ({
      id: `${record.specId}-T${String(index + 1)}`,
      title,
      status: "pending" as const,
      evidence: null,
    })),
  };
}

export type TaskCompletion =
  | {
      readonly outcome: "completed";
      readonly record: SpecificationRecord;
      readonly task: WorkflowTask;
    }
  | { readonly outcome: "unknown-task" }
  | { readonly outcome: "already-completed"; readonly task: WorkflowTask };

export function withCompletedTask(
  record: SpecificationRecord,
  taskId: string,
  evidence: string,
): TaskCompletion {
  const current = record.tasks.find((task) => task.id === taskId);
  if (current === undefined) return { outcome: "unknown-task" };
  if (current.status === "completed") {
    return { outcome: "already-completed", task: current };
  }

  const completed: WorkflowTask = {
    ...current,
    status: "completed",
    evidence,
  };
  const tasks = record.tasks.map((task) =>
    task.id === taskId ? completed : task,
  );
  return {
    outcome: "completed",
    record: {
      ...record,
      stage: tasks.every((task) => task.status === "completed")
        ? "delivered"
        : "implementing",
      revision: record.revision + 1,
      tasks,
    },
    task: completed,
  };
}

export function pendingTaskCount(record: SpecificationRecord): number {
  return record.tasks.filter((task) => task.status === "pending").length;
}
