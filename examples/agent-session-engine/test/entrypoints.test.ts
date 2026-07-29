import {
  type ChildProcessWithoutNullStreams,
  spawn,
  spawnSync,
} from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

const exampleRoot = fileURLToPath(new URL("..", import.meta.url));
const dataDirectories: string[] = [];

beforeAll(() => {
  const build = spawnSync(
    process.execPath,
    ["../../node_modules/typescript/bin/tsc", "-b", "--pretty", "false"],
    { cwd: exampleRoot, encoding: "utf8" },
  );
  if (build.status !== 0) {
    throw new Error(`Example build failed:\n${build.stdout}${build.stderr}`);
  }
});

afterEach(async () => {
  await Promise.all(
    dataDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function dataDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-session-entrypoint-"));
  dataDirectories.push(directory);
  return directory;
}

function run(
  entrypoint: string,
  args: ReadonlyArray<string>,
  directory: string,
  input?: string,
) {
  return spawnSync(process.execPath, [`dist/${entrypoint}.js`, ...args], {
    cwd: exampleRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      AGENT_SESSION_ENGINE_DATA_DIR: directory,
      AGENT_SESSION_ENGINE_SESSION_ID: "entrypoint-session",
    },
    ...(input === undefined ? {} : { input }),
  });
}

function runAsync(
  entrypoint: string,
  args: ReadonlyArray<string>,
  directory: string,
  input: string,
): Promise<{
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [`dist/${entrypoint}.js`, ...args], {
      cwd: exampleRoot,
      env: {
        ...process.env,
        AGENT_SESSION_ENGINE_DATA_DIR: directory,
        AGENT_SESSION_ENGINE_SESSION_ID: "entrypoint-session",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

function nextMessage(
  child: ChildProcessWithoutNullStreams,
  expectedId: number,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line === "") continue;
        const message = JSON.parse(line) as Record<string, unknown>;
        if (message.id === expectedId) {
          child.stdout.off("data", onData);
          resolve(message);
        }
      }
    };
    child.stdout.on("data", onData);
    child.once("error", reject);
    child.once("exit", (code) => {
      reject(new Error(`MCP stdio exited before response: ${String(code)}`));
    });
  });
}

function send(child: ChildProcessWithoutNullStreams, message: unknown): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

describe("agent session example entrypoints", () => {
  it("persists CLI commands across processes and serves the same session over MCP", async () => {
    const directory = await dataDirectory();
    const started = run(
      "cli",
      [
        "run",
        "agent-session.start",
        "--input",
        JSON.stringify({
          sessionId: "entrypoint-session",
          objective: "Prove adapter convergence.",
          workspaceRoot: "/workspace/project",
        }),
      ],
      directory,
    );
    expect(started.status).toBe(0);
    expect(started.stderr).toBe("");

    const created = run(
      "cli",
      [
        "run",
        "agent-session.create-task",
        "--input",
        JSON.stringify({
          sessionId: "entrypoint-session",
          taskId: "cross-process",
          title: "Read the state from another process",
          phase: "validation",
        }),
      ],
      directory,
    );
    expect(created.status).toBe(0);
    expect(JSON.parse(created.stdout)).toMatchObject({ sessionRevision: 2 });

    const child = spawn(process.execPath, ["dist/mcp-stdio.js"], {
      cwd: exampleRoot,
      env: {
        ...process.env,
        AGENT_SESSION_ENGINE_DATA_DIR: directory,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      const initialized = nextMessage(child, 1);
      send(child, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: {
            name: "agent-session-example-test",
            version: "0.0.0-test",
          },
        },
      });
      await expect(initialized).resolves.toMatchObject({
        result: {
          serverInfo: { name: "agent-session-engine", version: "0.1.0" },
        },
      });
      send(child, { jsonrpc: "2.0", method: "notifications/initialized" });

      const called = nextMessage(child, 2);
      send(child, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "agent-session.get",
          arguments: { sessionId: "entrypoint-session" },
        },
      });
      await expect(called).resolves.toMatchObject({
        result: {
          structuredContent: {
            sessionId: "entrypoint-session",
            revision: 2,
            tasks: [{ id: "cross-process", status: "pending" }],
          },
        },
      });
    } finally {
      child.kill();
    }
  });

  it("records a real hook process through the CLI adapter and returns resume context", async () => {
    const directory = await dataDirectory();
    const started = run(
      "cli",
      [
        "run",
        "agent-session.start",
        "--input",
        JSON.stringify({
          sessionId: "entrypoint-session",
          objective: "Resume from a Codex hook.",
          workspaceRoot: "/workspace/project",
        }),
      ],
      directory,
    );
    expect(started.status).toBe(0);

    const hook = run(
      "hook-cli",
      ["codex"],
      directory,
      JSON.stringify({
        session_id: "thr_codex",
        hook_event_name: "SessionStart",
        source: "resume",
        cwd: "/workspace/project",
      }),
    );
    expect(hook.status).toBe(0);
    expect(hook.stderr).toBe("");
    expect(JSON.parse(hook.stdout)).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: expect.stringContaining("Resume from a Codex hook."),
      },
    });

    const inspected = run(
      "cli",
      [
        "run",
        "agent-session.get",
        "--input",
        '{"sessionId":"entrypoint-session"}',
      ],
      directory,
    );
    expect(inspected.status).toBe(0);
    expect(JSON.parse(inspected.stdout)).toMatchObject({
      eventCount: 1,
      events: [
        {
          harness: "codex",
          nativeSessionId: "thr_codex",
          eventName: "SessionStart",
        },
      ],
    });
  });

  it("serializes concurrent hook processes without losing lifecycle events", async () => {
    const directory = await dataDirectory();
    const started = run(
      "cli",
      [
        "run",
        "agent-session.start",
        "--input",
        JSON.stringify({
          sessionId: "entrypoint-session",
          objective: "Capture concurrent hook processes.",
          workspaceRoot: "/workspace/project",
        }),
      ],
      directory,
    );
    expect(started.status).toBe(0);

    const hooks = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        runAsync(
          "hook-cli",
          ["codex"],
          directory,
          JSON.stringify({
            session_id: "thr_concurrent",
            hook_event_name: "PostToolUse",
            turn_id: "turn_concurrent",
            tool_use_id: `call_${String(index)}`,
            tool_name: "Bash",
            tool_response: { private: `payload-${String(index)}` },
            cwd: "/workspace/project",
          }),
        ),
      ),
    );
    expect(hooks).toEqual(
      Array.from({ length: 8 }, () => ({ code: 0, stdout: "{}", stderr: "" })),
    );

    const inspected = run(
      "cli",
      [
        "run",
        "agent-session.get",
        "--input",
        '{"sessionId":"entrypoint-session"}',
      ],
      directory,
    );
    expect(inspected.status).toBe(0);
    const session = JSON.parse(inspected.stdout) as {
      readonly eventCount: number;
      readonly events: ReadonlyArray<unknown>;
    };
    expect(session.eventCount).toBe(8);
    expect(session.events).toHaveLength(8);
    expect(inspected.stdout).not.toContain("payload-0");
  });

  it("ships parseable hook configurations for all four harnesses", async () => {
    const expected = {
      "cursor.hooks.json": [
        "workspaceOpen",
        "sessionStart",
        "sessionEnd",
        "beforeSubmitPrompt",
        "afterAgentResponse",
        "afterAgentThought",
        "preToolUse",
        "postToolUse",
        "postToolUseFailure",
        "beforeShellExecution",
        "afterShellExecution",
        "beforeMCPExecution",
        "afterMCPExecution",
        "beforeReadFile",
        "afterFileEdit",
        "beforeTabFileRead",
        "afterTabFileEdit",
        "subagentStart",
        "subagentStop",
        "preCompact",
        "stop",
      ],
      "codex.hooks.json": [
        "SessionStart",
        "SessionEnd",
        "UserPromptSubmit",
        "PreToolUse",
        "PermissionRequest",
        "PostToolUse",
        "PreCompact",
        "PostCompact",
        "SubagentStart",
        "SubagentStop",
        "Stop",
      ],
      "claude-code.settings.json": [
        "SessionStart",
        "Setup",
        "UserPromptSubmit",
        "UserPromptExpansion",
        "PreToolUse",
        "PermissionRequest",
        "PermissionDenied",
        "PostToolUse",
        "PostToolUseFailure",
        "PostToolBatch",
        "Notification",
        "MessageDisplay",
        "SubagentStart",
        "SubagentStop",
        "TaskCreated",
        "TaskCompleted",
        "Stop",
        "StopFailure",
        "TeammateIdle",
        "InstructionsLoaded",
        "ConfigChange",
        "CwdChanged",
        "WorktreeRemove",
        "PreCompact",
        "PostCompact",
        "Elicitation",
        "ElicitationResult",
        "SessionEnd",
      ],
      "antigravity.hooks.json": [
        "PreInvocation",
        "PostInvocation",
        "PostToolUse",
        "Stop",
      ],
    } as const;

    for (const [filename, eventNames] of Object.entries(expected)) {
      const encoded = await readFile(
        join(exampleRoot, "hooks", filename),
        "utf8",
      );
      const parsed = JSON.parse(encoded) as unknown;
      expect(parsed).toBeTypeOf("object");
      const root = parsed as Record<string, unknown>;
      const hookContainer =
        filename === "antigravity.hooks.json"
          ? (root["agent-session-recorder"] as Record<string, unknown>)
          : (root.hooks as Record<string, unknown>);
      expect(
        Object.keys(hookContainer)
          .filter((key) => key !== "enabled")
          .sort(),
      ).toEqual([...eventNames].sort());
      expect(encoded).toContain(
        "node examples/agent-session-engine/dist/hook-cli.js",
      );
    }
  });
});
