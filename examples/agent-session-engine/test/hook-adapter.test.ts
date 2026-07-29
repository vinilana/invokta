import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EngineEvent, Principal } from "@ai-engine/core";
import { afterEach, describe, expect, it } from "vitest";

import { createAgentSessionEngine } from "../src/engine.js";
import {
  normalizeHookEvent,
  runHookCommand,
} from "../src/hooks/hook-adapter.js";
import { createFileAgentSessionStore } from "../src/infrastructure/file-agent-session-store.js";

const principal: Principal = {
  id: "hook:recorder",
  attributes: { permissions: ["agent-session:hooks"] },
};
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const dataDirectory = await mkdtemp(join(tmpdir(), "agent-session-hook-"));
  temporaryDirectories.push(dataDirectory);
  const events: EngineEvent[] = [];
  const engine = createAgentSessionEngine(
    {
      sessions: createFileAgentSessionStore({ dataDirectory }),
      now: () => new Date("2026-07-28T12:00:00.000Z"),
    },
    {
      onEvent(event) {
        events.push(event);
      },
    },
  );
  return { dataDirectory, engine, events };
}

describe("agent harness hook adapters", () => {
  it("normalizes the same native occurrence to a stable event without retaining payload data", () => {
    const rawInput = JSON.stringify({
      session_id: "thr_123",
      hook_event_name: "PreToolUse",
      cwd: "/workspace/project",
      turn_id: "turn_1",
      tool_use_id: "call_1",
      tool_name: "Bash",
      tool_input: { command: "deploy --token secret-value" },
      prompt: "private prompt",
      reason: "secret-reason",
    });
    const first = normalizeHookEvent("codex", rawInput, {
      portableSessionId: "portable-session",
      observedAt: "2026-07-28T12:00:00.000Z",
    });
    const second = normalizeHookEvent("codex", rawInput, {
      portableSessionId: "portable-session",
      observedAt: "2026-07-28T12:00:01.000Z",
    });

    expect(first.eventId).toBe(second.eventId);
    expect(first).toMatchObject({
      sessionId: "portable-session",
      nativeSessionId: "thr_123",
      eventName: "PreToolUse",
      toolName: "Bash",
      nativeAgentId: null,
      nativeTaskId: null,
    });
    expect(first.payloadSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(first)).not.toContain("private prompt");
    expect(JSON.stringify(first)).not.toContain("secret-value");
    expect(first.outcome).toBe("other");

    const filesystemSafeDefault = normalizeHookEvent(
      "cursor",
      JSON.stringify({
        conversation_id: "native/session with spaces",
        hook_event_name: "sessionStart",
      }),
      { observedAt: "2026-07-28T12:00:00.000Z" },
    );
    expect(filesystemSafeDefault.sessionId).toMatch(/^cursor:[a-f0-9]{32}$/u);
  });

  it("records through runCli and injects resume context for Codex and Claude Code", async () => {
    const { engine, events } = await fixture();
    await engine.invoke(
      "agent-session.start",
      {
        sessionId: "handoff-session",
        objective: "Continue this work in another harness.",
        workspaceRoot: "/workspace/project",
      },
      {
        source: "direct",
        principal: {
          id: "agent:coordinator",
          attributes: { permissions: ["agent-session:write"] },
        },
      },
    );

    for (const harness of ["codex", "claude-code"] as const) {
      let stdout = "";
      let stderr = "";
      const code = await runHookCommand(harness, {
        rawInput: JSON.stringify({
          session_id: `${harness}-native-session`,
          hook_event_name: "SessionStart",
          source: "resume",
          cwd: "/workspace/project",
        }),
        portableSessionId: "handoff-session",
        engine,
        principal,
        observedAt: "2026-07-28T12:00:00.000Z",
        writeStdout: (text) => {
          stdout += text;
        },
        writeStderr: (text) => {
          stderr += text;
        },
      });

      expect(code).toBe(0);
      expect(stderr).toBe("");
      expect(JSON.parse(stdout)).toMatchObject({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: expect.stringContaining(
            "Continue this work in another harness.",
          ),
        },
      });
    }
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "invocation.started",
        capabilityId: "agent-session.record-hook-event",
        source: "cli",
      }),
    );
  });

  it("records repeated lifecycle deliveries that have no native occurrence identifier", async () => {
    const { engine } = await fixture();
    const rawInput = JSON.stringify({
      session_id: "codex-native-session",
      hook_event_name: "SessionStart",
      source: "resume",
      cwd: "/workspace/project",
    });

    for (const observedAt of [
      "2026-07-28T12:00:00.000Z",
      "2026-07-28T13:00:00.000Z",
    ]) {
      await expect(
        runHookCommand("codex", {
          rawInput,
          portableSessionId: "repeated-session-start",
          engine,
          principal,
          observedAt,
          writeStdout: () => undefined,
          writeStderr: () => undefined,
        }),
      ).resolves.toBe(0);
    }

    const session = await engine.invoke(
      "agent-session.get",
      { sessionId: "repeated-session-start" },
      {
        source: "direct",
        principal: {
          id: "reviewer",
          attributes: { permissions: ["agent-session:read"] },
        },
      },
    );
    expect(session.events).toHaveLength(2);
    expect(session.events.map(({ observedAt }) => observedAt)).toEqual([
      "2026-07-28T12:00:00.000Z",
      "2026-07-28T13:00:00.000Z",
    ]);
    expect(session.events[0]?.id).not.toBe(session.events[1]?.id);
  });

  it("uses each harness neutral output and resumes Antigravity on its first invocation", async () => {
    const { engine } = await fixture();
    await engine.invoke(
      "agent-session.start",
      {
        sessionId: "multi-harness",
        objective: "Resume safely.",
        workspaceRoot: "/workspace/project",
      },
      {
        source: "direct",
        principal: {
          id: "agent:coordinator",
          attributes: { permissions: ["agent-session:write"] },
        },
      },
    );

    const cases = [
      {
        harness: "cursor" as const,
        input: {
          conversation_id: "cursor-native",
          hook_event_name: "sessionStart",
          workspace_roots: ["/workspace/project"],
        },
        expected: {
          additional_context: expect.stringContaining("Resume safely."),
        },
      },
      {
        harness: "antigravity" as const,
        input: {
          conversationId: "agy-native",
          hook_event_name: "PreInvocation",
          invocationNum: 0,
          workspacePaths: ["/workspace/project"],
        },
        expected: {
          injectSteps: [
            { ephemeralMessage: expect.stringContaining("Resume safely.") },
          ],
        },
      },
      {
        harness: "antigravity" as const,
        input: {
          conversationId: "agy-native",
          hook_event_name: "PostToolUse",
          stepIdx: 2,
          workspacePaths: ["/workspace/project"],
        },
        expected: {},
      },
    ];

    for (const testCase of cases) {
      let stdout = "";
      const code = await runHookCommand(testCase.harness, {
        rawInput: JSON.stringify(testCase.input),
        portableSessionId: "multi-harness",
        engine,
        principal,
        observedAt: "2026-07-28T12:00:00.000Z",
        writeStdout: (text) => {
          stdout += text;
        },
        writeStderr: () => undefined,
      });
      expect(code).toBe(0);
      expect(JSON.parse(stdout)).toEqual(testCase.expected);
    }
  });
});
