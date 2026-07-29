import type { Principal } from "@invokta/core";

import type {
  ImplementationPlan,
  SpecificationDraft,
  SpecificationRecord,
} from "../domain/specification.js";

export interface AuthoringOptions {
  readonly signal: AbortSignal;
}

/**
 * The model-backed port. A deterministic template implementation ships with the
 * example; a prompt-and-model implementation replaces it without changing a
 * capability contract.
 */
export interface SpecificationAuthor {
  draftSpecification(
    request: { readonly specId: string; readonly intent: string },
    options: AuthoringOptions,
  ): Promise<SpecificationDraft>;
  draftPlan(
    request: { readonly specification: SpecificationDraft },
    options: AuthoringOptions,
  ): Promise<ImplementationPlan>;
  draftTasks(
    request: {
      readonly specification: SpecificationDraft;
      readonly plan: ImplementationPlan;
    },
    options: AuthoringOptions,
  ): Promise<ReadonlyArray<string>>;
}

export interface SpecificationStore {
  /** Returns `false` when the identifier is already taken. */
  create(record: SpecificationRecord): Promise<boolean>;
  findById(specId: string): Promise<SpecificationRecord | null>;
  /** Returns `false` when the stored revision moved on. */
  save(record: SpecificationRecord, expectedRevision: number): Promise<boolean>;
}

export type SpecPermission =
  | "spec:create"
  | "spec:plan"
  | "spec:break-down"
  | "spec:implement"
  | "spec:read";

export interface WorkflowPermissionChecker {
  can(
    principal: Principal,
    permission: SpecPermission,
    specId: string,
  ): boolean | Promise<boolean>;
}

export interface SpecDependencies {
  readonly specifications: SpecificationStore;
  readonly author: SpecificationAuthor;
  readonly permissions: WorkflowPermissionChecker;
}
