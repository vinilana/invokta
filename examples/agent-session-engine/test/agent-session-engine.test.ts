import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EngineError, EngineEvent, Principal } from "@ai-engine/core";
import { afterEach, describe, expect, it } from "vitest";

import { createAgentSessionEngine } from "../src/engine.js";
import { createFileAgentSessionStore } from "../src/infrastructure/file-agent-session-store.js";

const principal: Principal = {
  id: "agent:coordinator",
  attributes: {
    permissions: [
      "agent-session:read",
      "agent-session:write",
      "agent-session:hooks",
    ],
  },
};

const invocation = { source: "direct", principal } as const;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createTestEngine(events?: EngineEvent[]) {
  const dataDirectory = await mkdtemp(join(tmpdir(), "agent-session-engine-"));
  temporaryDirectories.push(dataDirectory);
  const create = () =>
    createAgentSessionEngine(
      {
        sessions: createFileAgentSessionStore({ dataDirectory }),
        now: () => new Date("2026-07-28T12:00:00.000Z"),
      },
      events === undefined
        ? undefined
        : {
            onEvent(event) {
              events.push(event);
            },
          },
    );
  const store = createFileAgentSessionStore({ dataDirectory });
  const engine = create();
  return { dataDirectory, create, engine, store };
}

describe("the agent session engine example", () => {
  it("persists a phase, tasks, checkpoints, and an owner handoff across engine processes", async () => {
    const { create, engine } = await createTestEngine();

    const started = await engine.invoke(
      "agent-session.start",
      {
        sessionId: "delivery-42",
        objective: "Deliver the portable agent session example.",
        workspaceRoot: "/workspace/ai-engines",
      },
      invocation,
    );
    expect(started).toMatchObject({
      sessionId: "delivery-42",
      phase: "discovery",
      status: "active",
      revision: 1,
      tasks: [],
      eventCount: 0,
    });

    const created = await engine.invoke(
      "agent-session.create-task",
      {
        sessionId: "delivery-42",
        taskId: "implement-store",
        title: "Implement the durable store",
        phase: "implementation",
        assignedHarness: "codex",
        assignedAgentId: "agent-a",
      },
      invocation,
    );
    expect(created.task).toMatchObject({
      id: "implement-store",
      status: "pending",
      revision: 1,
      owner: { harness: "codex", agentId: "agent-a" },
    });

    const inProgress = await engine.invoke(
      "agent-session.update-task",
      {
        sessionId: "delivery-42",
        taskId: "implement-store",
        expectedTaskRevision: 1,
        status: "in_progress",
        checkpoint:
          "The contract tests are red; implement the file adapter next.",
      },
      invocation,
    );
    expect(inProgress.task).toMatchObject({
      status: "in_progress",
      revision: 2,
    });

    const checkpointed = await engine.invoke(
      "agent-session.checkpoint",
      {
        sessionId: "delivery-42",
        expectedRevision: inProgress.sessionRevision,
        phase: "implementation",
        status: "paused",
        checkpoint: "The domain and contract tests are complete.",
        nextAction: "Implement and verify the file-backed adapter.",
      },
      invocation,
    );

    const resumed = await create().invoke(
      "agent-session.get",
      { sessionId: "delivery-42" },
      invocation,
    );
    expect(resumed).toMatchObject({
      phase: "implementation",
      status: "paused",
      revision: checkpointed.revision,
      checkpoint: "The domain and contract tests are complete.",
      nextAction: "Implement and verify the file-backed adapter.",
    });
    expect(resumed.resumeContext).toContain("Implement and verify");

    const handedOff = await create().invoke(
      "agent-session.update-task",
      {
        sessionId: "delivery-42",
        taskId: "implement-store",
        expectedTaskRevision: 2,
        assignedHarness: "claude-code",
        assignedAgentId: "agent-b",
      },
      invocation,
    );
    expect(handedOff.task).toMatchObject({
      revision: 3,
      owner: { harness: "claude-code", agentId: "agent-b" },
      checkpoint:
        "The contract tests are red; implement the file adapter next.",
    });
  });

  it("allows only one concurrent update from the same task revision", async () => {
    const { create, engine } = await createTestEngine();
    await engine.invoke(
      "agent-session.start",
      {
        sessionId: "concurrent-session",
        objective: "Prove optimistic task ownership.",
        workspaceRoot: "/workspace/project",
      },
      invocation,
    );
    await engine.invoke(
      "agent-session.create-task",
      {
        sessionId: "concurrent-session",
        taskId: "task-1",
        title: "Own this task exactly once",
        phase: "implementation",
      },
      invocation,
    );

    const outcomes = await Promise.allSettled([
      engine.invoke(
        "agent-session.update-task",
        {
          sessionId: "concurrent-session",
          taskId: "task-1",
          expectedTaskRevision: 1,
          assignedHarness: "codex",
          assignedAgentId: "agent-a",
        },
        invocation,
      ),
      create().invoke(
        "agent-session.update-task",
        {
          sessionId: "concurrent-session",
          taskId: "task-1",
          expectedTaskRevision: 1,
          assignedHarness: "cursor",
          assignedAgentId: "agent-b",
        },
        invocation,
      ),
    ]);

    expect(
      outcomes.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = outcomes.find(({ status }) => status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining<Partial<EngineError>>({
        code: "EXECUTION_FAILED",
        message: "The task changed before this update.",
        publicDetails: {
          sessionId: "concurrent-session",
          taskId: "task-1",
          expectedTaskRevision: 1,
        },
      }),
    });
  });

  it("records only hook metadata and a payload digest through the engine pipeline", async () => {
    const events: EngineEvent[] = [];
    const { engine } = await createTestEngine(events);

    const recorded = await engine.invoke(
      "agent-session.record-hook-event",
      {
        sessionId: "portable-session",
        harness: "codex",
        nativeSessionId: "thr_native",
        eventId: "evt_0123456789abcdef0123456789abcdef",
        eventName: "PreToolUse",
        observedAt: "2026-07-28T12:00:00.000Z",
        workspaceRoot: "/workspace/project",
        toolName: "Bash",
        nativeAgentId: null,
        nativeTaskId: null,
        outcome: null,
        payloadSha256:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      },
      invocation,
    );
    expect(recorded).toMatchObject({ recorded: true, resumed: false });

    const session = await engine.invoke(
      "agent-session.get",
      { sessionId: "portable-session" },
      invocation,
    );
    expect(session.harnessSessions).toEqual([
      { harness: "codex", nativeSessionId: "thr_native" },
    ]);
    expect(session.events).toEqual([
      expect.objectContaining({
        eventName: "PreToolUse",
        toolName: "Bash",
        payloadSha256:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      }),
    ]);
    expect(JSON.stringify(session)).not.toContain("tool_input");
    expect(events).toEqual([
      expect.objectContaining({
        type: "invocation.started",
        capabilityId: "agent-session.record-hook-event",
        source: "direct",
      }),
      expect.objectContaining({
        type: "invocation.completed",
        capabilityId: "agent-session.record-hook-event",
      }),
      expect.objectContaining({
        type: "invocation.started",
        capabilityId: "agent-session.get",
      }),
      expect.objectContaining({
        type: "invocation.completed",
        capabilityId: "agent-session.get",
      }),
    ]);
  });

  it("rejects anonymous access and stale session checkpoints", async () => {
    const { engine } = await createTestEngine();
    await expect(
      engine.invoke(
        "agent-session.get",
        { sessionId: "missing" },
        { source: "direct", principal: null },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });

    await engine.invoke(
      "agent-session.start",
      {
        sessionId: "stale-session",
        objective: "Reject lost session updates.",
        workspaceRoot: "/workspace/project",
      },
      invocation,
    );
    await engine.invoke(
      "agent-session.checkpoint",
      {
        sessionId: "stale-session",
        expectedRevision: 1,
        phase: "planning",
        status: "active",
        checkpoint: "Plan drafted.",
        nextAction: "Create tasks.",
      },
      invocation,
    );
    await expect(
      engine.invoke(
        "agent-session.checkpoint",
        {
          sessionId: "stale-session",
          expectedRevision: 1,
          phase: "delivery",
          status: "completed",
          checkpoint: "Stale writer claims completion.",
          nextAction: null,
        },
        invocation,
      ),
    ).rejects.toMatchObject({
      code: "EXECUTION_FAILED",
      message: "The session changed before this checkpoint.",
      publicDetails: { sessionId: "stale-session", expectedRevision: 1 },
    });
  });

  it("deduplicates an identical hook redelivery", async () => {
    const { engine } = await createTestEngine();
    const input = {
      sessionId: "deduplicated-session",
      harness: "cursor" as const,
      nativeSessionId: "cursor-native",
      eventId: "evt_abcdefabcdefabcdefabcdefabcdefab",
      eventName: "postToolUse",
      observedAt: "2026-07-28T12:00:00.000Z",
      workspaceRoot: "/workspace/project",
      toolName: "Shell",
      nativeAgentId: null,
      nativeTaskId: null,
      outcome: null,
      payloadSha256:
        "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    };

    const first = await engine.invoke(
      "agent-session.record-hook-event",
      input,
      invocation,
    );
    const duplicate = await engine.invoke(
      "agent-session.record-hook-event",
      input,
      invocation,
    );
    const session = await engine.invoke(
      "agent-session.get",
      { sessionId: "deduplicated-session" },
      invocation,
    );

    expect(first.recorded).toBe(true);
    expect(duplicate).toMatchObject({
      recorded: false,
      sessionRevision: first.sessionRevision,
    });
    expect(session.eventCount).toBe(1);
  });

  it("enforces the task count and completion-evidence boundaries", async () => {
    const { engine, store } = await createTestEngine();
    await engine.invoke(
      "agent-session.start",
      {
        sessionId: "bounded-session",
        objective: "Exercise public task limits.",
        workspaceRoot: "/workspace/project",
      },
      invocation,
    );
    await engine.invoke(
      "agent-session.create-task",
      {
        sessionId: "bounded-session",
        taskId: "evidence-task",
        title: "Require evidence",
        phase: "validation",
      },
      invocation,
    );
    await expect(
      engine.invoke(
        "agent-session.update-task",
        {
          sessionId: "bounded-session",
          taskId: "evidence-task",
          expectedTaskRevision: 1,
          status: "completed",
        },
        invocation,
      ),
    ).rejects.toMatchObject({
      message: "A completed task requires verification evidence.",
    });

    const current = await store.findById("bounded-session");
    if (current === null) throw new Error("Expected the bounded session.");
    const timestamp = "2026-07-28T12:00:00.000Z";
    const tasks = Array.from({ length: 256 }, (_, index) => ({
      id: `task-${String(index)}`,
      title: `Task ${String(index)}`,
      phase: "implementation" as const,
      status: "pending" as const,
      owner: null,
      checkpoint: null,
      evidence: null,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    }));
    await expect(
      store.save(
        {
          ...current,
          revision: current.revision + 1,
          tasks,
          updatedAt: timestamp,
        },
        current.revision,
      ),
    ).resolves.toBe("saved");
    await expect(
      engine.invoke(
        "agent-session.create-task",
        {
          sessionId: "bounded-session",
          taskId: "one-too-many",
          title: "Exceed the task limit",
          phase: "implementation",
        },
        invocation,
      ),
    ).rejects.toMatchObject({
      code: "EXECUTION_FAILED",
      message: "The agent session task limit was reached.",
      publicDetails: { sessionId: "bounded-session", limit: 256 },
    });
  });
});
