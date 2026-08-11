import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { exampleCandidate } from "../src/example-candidate.js";

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

describe("review engine entrypoints", () => {
  it("assesses a ready candidate through the direct entrypoint", () => {
    const result = run("direct");

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      taskId: "TASK-DEMO",
      policyVersion: "2026-07-28",
      readyToComplete: true,
      decision: "pass",
      blockers: [],
      nextAction: "declare-complete",
    });
  });

  it("publishes and invokes the same capability through the CLI", () => {
    const listed = run("cli", ["list"]);
    expect(listed.status).toBe(0);
    expect(JSON.parse(listed.stdout)).toMatchObject([
      { id: "review.assess-task-readiness" },
    ]);

    const assessed = run("cli", [
      "run",
      "review.assess-task-readiness",
      "--input",
      JSON.stringify(exampleCandidate),
    ]);
    expect(assessed.status).toBe(0);
    expect(assessed.stderr).toBe("");
    expect(JSON.parse(assessed.stdout)).toMatchObject({
      readyToComplete: true,
      nextAction: "declare-complete",
    });
  });

  it("returns a fail-closed decision through MCP stdio", async () => {
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
      { name: "review-stdio-entrypoint-test", version: "0.0.0-test" },
      { capabilities: {} },
    );

    try {
      await client.connect(transport);
      await expect(client.listTools()).resolves.toMatchObject({
        tools: [{ name: "review_assess-task-readiness" }],
      });
      const result = await client.callTool({
        name: "review_assess-task-readiness",
        arguments: {
          ...exampleCandidate,
          evidence: exampleCandidate.evidence.filter(
            ({ id }) => id !== "ADV-TEST-2",
          ),
        },
      });
      expect(structuredContent(result)).toMatchObject({
        readyToComplete: false,
        gates: { adversarialReview: { verdict: "fail" } },
        nextAction: "address-blockers-and-rerun",
      });
    } finally {
      await client.close();
    }

    expect(stderr).toBe("");
  });

  it("serves authenticated stateless HTTP without exposing the token", async () => {
    const token = "test-only-review-token";
    const child = spawn(process.execPath, ["dist/mcp-http.js"], {
      cwd: exampleRoot,
      env: { ...process.env, REVIEW_ENGINE_BEARER_TOKEN: token, PORT: "0" },
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
            name: "review_assess-task-readiness",
            arguments: exampleCandidate,
          },
        }),
      });
      expect(unauthenticated.status).toBe(401);
      await unauthenticated.arrayBuffer();

      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      });
      client = new Client(
        { name: "review-http-entrypoint-test", version: "0.0.0-test" },
        { capabilities: {} },
      );
      await client.connect(transport as unknown as Transport);

      const result = await client.callTool({
        name: "review_assess-task-readiness",
        arguments: exampleCandidate as unknown as Record<string, unknown>,
      });
      expect(structuredContent(result)).toMatchObject({
        readyToComplete: true,
        nextAction: "declare-complete",
      });
    } finally {
      await client?.close().catch(() => undefined);
      await stopProcess(child);
    }

    expect(stdout).toBe("");
    expect(stderr).not.toContain(token);
  });
});
