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

describe("Cursor agent routing engine entrypoints", () => {
  it("routes through the direct entrypoint", () => {
    const result = run("direct", ["debug"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      useCase: "debug",
      agent: { name: "debugger" },
      primaryModel: { selector: "gpt-5.6-sol" },
    });
  });

  it("routes the same capability through the CLI", () => {
    const result = run("cli", [
      "run",
      "developer-work.route-cursor-task",
      "--input",
      '{"useCase":"documentation"}',
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      useCase: "documentation",
      agent: { name: "documenter" },
      primaryModel: { selector: "gemini-3.6-flash" },
    });
  });

  it("publishes the same route over MCP stdio", async () => {
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
      { name: "cursor-routing-stdio-test", version: "0.0.0-test" },
      { capabilities: {} },
    );

    try {
      await client.connect(transport);
      await expect(client.listTools()).resolves.toMatchObject({
        tools: [{ name: "developer-work_route-cursor-task" }],
      });

      const result = await client.callTool({
        name: "developer-work_route-cursor-task",
        arguments: { useCase: "complex-development" },
      });
      expect(structuredContent(result)).toMatchObject({
        useCase: "complex-development",
        agent: { name: "complex-builder" },
        primaryModel: { selector: "grok-4.5" },
      });
    } finally {
      await client.close();
    }

    expect(stderr).toBe("");
  });

  it("requires HTTP authentication before publishing the same route", async () => {
    const token = "test-only-cursor-routing-token";
    const child = spawn(process.execPath, ["dist/mcp-http.js"], {
      cwd: exampleRoot,
      env: {
        ...process.env,
        CURSOR_ROUTING_ENGINE_BEARER_TOKEN: token,
        PORT: "0",
      },
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
            name: "developer-work_route-cursor-task",
            arguments: { useCase: "simple-development" },
          },
        }),
      });
      expect(unauthenticated.status).toBe(401);
      await unauthenticated.arrayBuffer();

      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      });
      client = new Client(
        { name: "cursor-routing-http-test", version: "0.0.0-test" },
        { capabilities: {} },
      );
      await client.connect(transport as unknown as Transport);

      const result = await client.callTool({
        name: "developer-work_route-cursor-task",
        arguments: { useCase: "simple-development" },
      });
      expect(structuredContent(result)).toMatchObject({
        useCase: "simple-development",
        agent: { name: "simple-builder" },
        primaryModel: { selector: "gpt-5.6-luna" },
      });
    } finally {
      await client?.close();
      await stopProcess(child);
    }

    expect(stdout).toBe("");
  });
});
