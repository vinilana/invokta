import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { beforeAll, describe, expect, it, vi } from "vitest";

const exampleRoot = fileURLToPath(new URL("..", import.meta.url));

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

function run(entrypoint: string, args: readonly string[] = []) {
  return spawnSync(process.execPath, [`dist/${entrypoint}.js`, ...args], {
    cwd: exampleRoot,
    encoding: "utf8",
  });
}

async function stopProcess(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill();
  await exited;
}

function structuredContent(result: unknown): Record<string, unknown> {
  const content = (result as { readonly structuredContent?: unknown })
    .structuredContent;
  if (typeof content !== "object" || content === null) {
    throw new Error("Expected MCP structured content.");
  }
  return content as Record<string, unknown>;
}

describe("spec engine entrypoints", () => {
  it("drives the whole workflow through the direct entrypoint", () => {
    const result = run("direct");

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const status = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(status).toMatchObject({
      specId: "SPEC-DEMO",
      stage: "delivered",
      revision: 6,
      pendingTasks: 0,
      nextCapability: null,
    });
    expect(status.tasks).toEqual([
      {
        id: "SPEC-DEMO-T1",
        title: "Implement requirement 1.",
        status: "completed",
        evidence: "vitest run spec-demo-t1",
      },
      {
        id: "SPEC-DEMO-T2",
        title: "Implement requirement 2.",
        status: "completed",
        evidence: "vitest run spec-demo-t2",
      },
      {
        id: "SPEC-DEMO-T3",
        title: "Verify every acceptance criterion.",
        status: "completed",
        evidence: "vitest run spec-demo-t3",
      },
    ]);
  });

  it("advances one workflow step per CLI invocation and refuses an out-of-order step", () => {
    const listed = run("cli", ["list"]);
    expect(listed.status).toBe(0);
    expect(
      (JSON.parse(listed.stdout) as ReadonlyArray<{ id: string }>).map(
        ({ id }) => id,
      ),
    ).toEqual([
      "spec.create-specification",
      "spec.plan-implementation",
      "spec.break-down-tasks",
      "spec.complete-task",
      "spec.get-workflow-status",
    ]);

    const status = run("cli", [
      "run",
      "spec.get-workflow-status",
      "--input",
      JSON.stringify({ specId: "SPEC-1" }),
    ]);
    expect(status.status).toBe(0);
    expect(status.stderr).toBe("");
    expect(JSON.parse(status.stdout)).toMatchObject({
      specId: "SPEC-1",
      stage: "drafted",
      nextCapability: "spec.plan-implementation",
    });

    const planned = run("cli", [
      "run",
      "spec.plan-implementation",
      "--input",
      JSON.stringify({ specId: "SPEC-1" }),
    ]);
    expect(planned.status).toBe(0);
    expect(JSON.parse(planned.stdout)).toMatchObject({
      stage: "planned",
      revision: 2,
    });

    const outOfOrder = run("cli", [
      "run",
      "spec.complete-task",
      "--input",
      JSON.stringify({
        specId: "SPEC-1",
        taskId: "SPEC-1-T1",
        evidence: "vitest run",
      }),
    ]);
    expect(outOfOrder.status).toBe(1);
    expect(outOfOrder.stdout).toBe("");
    expect(JSON.parse(outOfOrder.stderr)).toMatchObject({
      error: {
        code: "EXECUTION_FAILED",
        message: "The workflow stage does not allow this step.",
        publicDetails: {
          specId: "SPEC-1",
          stage: "drafted",
          expectedStages: ["tasked", "implementing"],
        },
      },
    });
  });

  it("keeps workflow state within one stdio process", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["dist/mcp-stdio.js"],
      cwd: exampleRoot,
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    const client = new Client(
      { name: "spec-stdio-entrypoint-test", version: "0.0.0-test" },
      { capabilities: {} },
    );

    try {
      await client.connect(transport);
      await expect(client.listTools()).resolves.toMatchObject({
        tools: [
          { name: "spec.create-specification" },
          { name: "spec.plan-implementation" },
          { name: "spec.break-down-tasks" },
          { name: "spec.complete-task" },
          { name: "spec.get-workflow-status" },
        ],
      });

      const planned = await client.callTool({
        name: "spec.plan-implementation",
        arguments: { specId: "SPEC-1" },
      });
      expect(structuredContent(planned)).toMatchObject({
        stage: "planned",
        revision: 2,
      });

      const status = await client.callTool({
        name: "spec.get-workflow-status",
        arguments: { specId: "SPEC-1" },
      });
      expect(structuredContent(status)).toMatchObject({
        stage: "planned",
        nextCapability: "spec.break-down-tasks",
      });
    } finally {
      await client.close();
    }

    expect(stderr).toBe("");
  });

  it("serves authenticated stateless HTTP for the same workflow", async () => {
    const token = "test-only-spec-token";
    const child = spawn(process.execPath, ["dist/mcp-http.js"], {
      cwd: exampleRoot,
      env: { ...process.env, SPEC_ENGINE_BEARER_TOKEN: token, PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    let client: Client | undefined;

    try {
      const port = await vi.waitFor(
        () => {
          const match = stderr.match(/host 127\.0\.0\.1, port (\d+)/u);
          expect(match?.[1]).toBeDefined();
          return Number(match?.[1]);
        },
        { timeout: 5_000 },
      );
      const url = new URL(`http://127.0.0.1:${String(port)}/mcp`);

      const unauthenticated = await fetch(url, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "auth-boundary",
          method: "tools/call",
          params: {
            name: "spec.get-workflow-status",
            arguments: { specId: "SPEC-1" },
          },
        }),
      });
      expect(unauthenticated.status).toBe(401);
      await unauthenticated.arrayBuffer();

      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      });
      client = new Client(
        { name: "spec-http-entrypoint-test", version: "0.0.0-test" },
        { capabilities: {} },
      );
      await client.connect(transport as unknown as Transport);

      const created = await client.callTool({
        name: "spec.create-specification",
        arguments: {
          specId: "SPEC-HTTP",
          intent: "Publish a stateless HTTP workflow example",
        },
      });
      expect(structuredContent(created)).toMatchObject({
        specId: "SPEC-HTTP",
        stage: "drafted",
      });

      const status = await client.callTool({
        name: "spec.get-workflow-status",
        arguments: { specId: "SPEC-HTTP" },
      });
      expect(structuredContent(status)).toMatchObject({
        stage: "drafted",
        nextCapability: "spec.plan-implementation",
      });
    } finally {
      await client?.close().catch(() => undefined);
      await stopProcess(child);
    }

    expect(stdout).toBe("");
    expect(stderr).not.toContain(token);
  });
});
