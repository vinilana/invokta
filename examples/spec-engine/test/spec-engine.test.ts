import type { EngineError, Principal } from "@invokta/core";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import type { SpecificationAuthor } from "../src/application/ports.js";
import { nextCapability } from "../src/domain/workflow.js";
import { createSpecEngine, seededSpecification } from "../src/engine.js";
import { createAttributeWorkflowPermissionChecker } from "../src/infrastructure/attribute-workflow-permission-checker.js";
import { createInMemorySpecificationStore } from "../src/infrastructure/in-memory-specification-store.js";
import { createTemplateSpecificationAuthor } from "../src/infrastructure/template-specification-author.js";

const principal: Principal = {
  id: "agent:spec-lead",
  attributes: {
    permissions: [
      "spec:create",
      "spec:plan",
      "spec:break-down",
      "spec:implement",
      "spec:read",
    ],
  },
};

const invocation = { source: "direct", principal } as const;
const intent =
  "Publish a ticket classification capability; reject a request from an unauthorized principal";

function createDependencies(seedDrafted = true) {
  return {
    specifications: createInMemorySpecificationStore(
      seedDrafted ? [seededSpecification] : [],
    ),
    author: createTemplateSpecificationAuthor(),
    permissions: createAttributeWorkflowPermissionChecker(),
  };
}

describe("the spec engine example", () => {
  it("runs the whole spec-driven workflow through repeated invocations", async () => {
    const engine = createSpecEngine(createDependencies(false));

    const created = await engine.invoke(
      "spec.create-specification",
      { specId: "SPEC-7", intent },
      invocation,
    );
    expectTypeOf(created.stage).toEqualTypeOf<
      "drafted" | "planned" | "tasked" | "implementing" | "delivered"
    >();
    expect(created).toMatchObject({
      specId: "SPEC-7",
      stage: "drafted",
      revision: 1,
    });
    expect(created.specification.requirements).toHaveLength(2);

    const planned = await engine.invoke(
      "spec.plan-implementation",
      { specId: "SPEC-7" },
      invocation,
    );
    expect(planned).toMatchObject({ stage: "planned", revision: 2 });
    expect(planned.plan.steps).toHaveLength(4);

    const tasked = await engine.invoke(
      "spec.break-down-tasks",
      { specId: "SPEC-7" },
      invocation,
    );
    expect(tasked).toMatchObject({ stage: "tasked", revision: 3 });
    expect(tasked.tasks.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "SPEC-7-T1", status: "pending" },
      { id: "SPEC-7-T2", status: "pending" },
      { id: "SPEC-7-T3", status: "pending" },
    ]);

    const first = await engine.invoke(
      "spec.complete-task",
      {
        specId: "SPEC-7",
        taskId: "SPEC-7-T1",
        evidence: "vitest run spec-7-t1",
      },
      invocation,
    );
    expect(first).toMatchObject({
      stage: "implementing",
      pendingTasks: 2,
      task: {
        id: "SPEC-7-T1",
        status: "completed",
        evidence: "vitest run spec-7-t1",
      },
    });

    for (const taskId of ["SPEC-7-T2", "SPEC-7-T3"]) {
      await engine.invoke(
        "spec.complete-task",
        { specId: "SPEC-7", taskId, evidence: `vitest run ${taskId}` },
        invocation,
      );
    }

    const status = await engine.invoke(
      "spec.get-workflow-status",
      { specId: "SPEC-7" },
      invocation,
    );
    expect(status).toMatchObject({
      stage: "delivered",
      revision: 6,
      pendingTasks: 0,
      nextCapability: null,
    });
    expect(
      status.tasks.every(({ status: state }) => state === "completed"),
    ).toBe(true);
  });

  it("refuses a step the current stage does not allow", async () => {
    const engine = createSpecEngine(createDependencies());

    await expect(
      engine.invoke("spec.break-down-tasks", { specId: "SPEC-1" }, invocation),
    ).rejects.toEqual(
      expect.objectContaining<Partial<EngineError>>({
        code: "EXECUTION_FAILED",
        message: "The workflow stage does not allow this step.",
        publicDetails: {
          specId: "SPEC-1",
          stage: "drafted",
          expectedStages: ["planned"],
        },
      }),
    );

    await expect(
      engine.invoke(
        "spec.complete-task",
        { specId: "SPEC-1", taskId: "SPEC-1-T1", evidence: "vitest run" },
        invocation,
      ),
    ).rejects.toMatchObject({
      publicDetails: {
        stage: "drafted",
        expectedStages: ["tasked", "implementing"],
      },
    });
  });

  it("reports an unknown specification and a duplicate identifier safely", async () => {
    const engine = createSpecEngine(createDependencies());

    await expect(
      engine.invoke(
        "spec.plan-implementation",
        { specId: "SPEC-404" },
        invocation,
      ),
    ).rejects.toMatchObject({
      code: "EXECUTION_FAILED",
      message: "Specification not found.",
      publicDetails: { specId: "SPEC-404" },
    });

    await expect(
      engine.invoke(
        "spec.create-specification",
        { specId: "SPEC-1", intent },
        invocation,
      ),
    ).rejects.toMatchObject({
      message: "Specification already exists.",
      publicDetails: { specId: "SPEC-1" },
    });
  });

  it("authorizes each workflow step separately", async () => {
    const dependencies = createDependencies();
    const engine = createSpecEngine(dependencies);
    const reviewer: Principal = {
      id: "agent:reviewer",
      attributes: { permissions: ["spec:read"] },
    };

    await expect(
      engine.invoke(
        "spec.get-workflow-status",
        { specId: "SPEC-1" },
        { source: "direct", principal: reviewer },
      ),
    ).resolves.toMatchObject({ stage: "drafted" });
    await expect(
      engine.invoke(
        "spec.plan-implementation",
        { specId: "SPEC-1" },
        { source: "direct", principal: reviewer },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      engine.invoke(
        "spec.get-workflow-status",
        { specId: "SPEC-1" },
        {
          source: "direct",
          principal: null,
        },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(
      dependencies.specifications.findById("SPEC-1"),
    ).resolves.toMatchObject({ stage: "drafted", revision: 1 });
  });

  it("restricts a principal to the specifications it is scoped to", async () => {
    const engine = createSpecEngine(createDependencies());
    const scoped: Principal = {
      id: "agent:scoped",
      attributes: {
        permissions: ["spec:read"],
        allowedSpecIds: ["SPEC-2"],
      },
    };

    await expect(
      engine.invoke(
        "spec.get-workflow-status",
        { specId: "SPEC-1" },
        { source: "direct", principal: scoped },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("requires verification evidence before a task can be completed", async () => {
    const engine = createSpecEngine(createDependencies());

    await expect(
      engine.invoke(
        "spec.complete-task",
        { specId: "SPEC-1", taskId: "SPEC-1-T1", evidence: "   " },
        invocation,
      ),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });

  it("rejects an unknown task and a task that is already completed", async () => {
    const engine = createSpecEngine(createDependencies(false));
    await engine.invoke(
      "spec.create-specification",
      { specId: "SPEC-8", intent },
      invocation,
    );
    await engine.invoke(
      "spec.plan-implementation",
      { specId: "SPEC-8" },
      invocation,
    );
    await engine.invoke(
      "spec.break-down-tasks",
      { specId: "SPEC-8" },
      invocation,
    );
    await engine.invoke(
      "spec.complete-task",
      { specId: "SPEC-8", taskId: "SPEC-8-T1", evidence: "vitest run" },
      invocation,
    );

    await expect(
      engine.invoke(
        "spec.complete-task",
        { specId: "SPEC-8", taskId: "SPEC-8-T9", evidence: "vitest run" },
        invocation,
      ),
    ).rejects.toMatchObject({
      message: "Task not found in this specification.",
      publicDetails: { specId: "SPEC-8", taskId: "SPEC-8-T9" },
    });
    await expect(
      engine.invoke(
        "spec.complete-task",
        { specId: "SPEC-8", taskId: "SPEC-8-T1", evidence: "vitest run" },
        invocation,
      ),
    ).rejects.toMatchObject({ message: "Task is already completed." });
  });

  it("rejects a concurrent write that started from an older revision", async () => {
    const engine = createSpecEngine(createDependencies(false));
    await engine.invoke(
      "spec.create-specification",
      { specId: "SPEC-9", intent },
      invocation,
    );
    await engine.invoke(
      "spec.plan-implementation",
      { specId: "SPEC-9" },
      invocation,
    );
    await engine.invoke(
      "spec.break-down-tasks",
      { specId: "SPEC-9" },
      invocation,
    );

    const results = await Promise.allSettled([
      engine.invoke(
        "spec.complete-task",
        { specId: "SPEC-9", taskId: "SPEC-9-T1", evidence: "vitest run t1" },
        invocation,
      ),
      engine.invoke(
        "spec.complete-task",
        { specId: "SPEC-9", taskId: "SPEC-9-T2", evidence: "vitest run t2" },
        invocation,
      ),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected?.reason).toMatchObject({
      code: "EXECUTION_FAILED",
      message: "The specification changed during this invocation.",
      publicDetails: { specId: "SPEC-9" },
    });
  });

  it("propagates caller cancellation to the authoring port", async () => {
    const dependencies = createDependencies();
    let authorSignal: AbortSignal | undefined;
    const author: SpecificationAuthor = {
      ...dependencies.author,
      draftPlan: vi.fn(async (_request, { signal }) => {
        authorSignal = signal;
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
        return { approach: "Unreachable.", steps: [], risks: [] };
      }),
    };
    const engine = createSpecEngine({ ...dependencies, author });
    const controller = new AbortController();

    const invoked = engine.invoke(
      "spec.plan-implementation",
      { specId: "SPEC-1" },
      { ...invocation, signal: controller.signal },
    );
    await vi.waitFor(() => expect(authorSignal).toBeDefined());
    controller.abort(new Error("The delivery session ended."));

    await expect(invoked).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(
      dependencies.specifications.findById("SPEC-1"),
    ).resolves.toMatchObject({ stage: "drafted", revision: 1 });
  });

  it("publishes the workflow as five capabilities with one read-only step", () => {
    const engine = createSpecEngine(createDependencies());

    expect(engine.list().map(({ id }) => id)).toEqual([
      "spec.create-specification",
      "spec.plan-implementation",
      "spec.break-down-tasks",
      "spec.complete-task",
      "spec.get-workflow-status",
    ]);
    expect(engine.describe("spec.complete-task")).toMatchObject({
      title: "Complete task",
      timeoutMs: 30_000,
      annotations: {
        readOnly: false,
        destructive: false,
        idempotent: false,
        openWorld: false,
      },
      inputSchema: {
        type: "object",
        required: ["specId", "taskId", "evidence"],
      },
    });
    expect(engine.describe("spec.get-workflow-status")).toMatchObject({
      annotations: { readOnly: true, idempotent: true },
    });
  });

  it("names the next capability for every stage", () => {
    const record = { ...seededSpecification };

    expect(nextCapability({ ...record, stage: "drafted" })).toBe(
      "spec.plan-implementation",
    );
    expect(nextCapability({ ...record, stage: "planned" })).toBe(
      "spec.break-down-tasks",
    );
    expect(nextCapability({ ...record, stage: "tasked" })).toBe(
      "spec.complete-task",
    );
    expect(nextCapability({ ...record, stage: "implementing" })).toBe(
      "spec.complete-task",
    );
    expect(nextCapability({ ...record, stage: "delivered" })).toBeNull();
  });
});
