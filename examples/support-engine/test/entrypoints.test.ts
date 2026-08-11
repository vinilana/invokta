import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { beforeAll, describe, expect, it, vi } from "vitest";

const exampleRoot = fileURLToPath(new URL("..", import.meta.url));
const capabilityId = "support.classify-ticket";
const toolName = "support_classify-ticket";

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

function toolErrorPayload(result: unknown): unknown {
  const content = (result as { readonly content?: unknown }).content;
  if (!Array.isArray(content)) throw new Error("Expected MCP tool content.");
  const text = content.find(
    (item): item is { readonly type: "text"; readonly text: string } =>
      typeof item === "object" &&
      item !== null &&
      "type" in item &&
      item.type === "text" &&
      "text" in item &&
      typeof item.text === "string",
  );
  if (text === undefined) throw new Error("Expected a text tool error.");
  return JSON.parse(text.text) as unknown;
}

describe("support engine entrypoints", () => {
  it("runs the capability directly with result-only stdout", () => {
    const result = run("direct");

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      `${JSON.stringify({
        category: "billing",
        confidence: 0.9,
        rationale: "The ticket contains language associated with billing.",
      })}\n`,
    );
  });

  it("runs the same capability through the CLI and rejects identity spoofing", () => {
    const success = run("cli", [
      "run",
      capabilityId,
      "--input",
      JSON.stringify({ ticketId: "T-456" }),
    ]);

    expect(success.status).toBe(0);
    expect(success.stderr).toBe("");
    expect(JSON.parse(success.stdout)).toEqual({
      category: "technical",
      confidence: 0.9,
      rationale: "The ticket contains language associated with technical.",
    });

    const spoofed = run("cli", [
      "run",
      capabilityId,
      "--input",
      JSON.stringify({
        ticketId: "T-999",
        principal: {
          id: "attacker",
          attributes: { permissions: ["ticket:classify"] },
        },
      }),
    ]);

    expect(spoofed.status).toBe(1);
    expect(spoofed.stdout).toBe("");
    expect(JSON.parse(spoofed.stderr)).toMatchObject({
      error: { code: "FORBIDDEN" },
    });
    expect(spoofed.stderr).not.toContain("attacker");
  });

  it("serves the same capability over protocol-only stdio", async () => {
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
      { name: "support-stdio-entrypoint-test", version: "0.0.0-test" },
      { capabilities: {} },
    );

    try {
      await client.connect(transport);
      await expect(client.listTools()).resolves.toMatchObject({
        tools: [{ name: toolName }],
      });
      await expect(
        client.callTool({
          name: toolName,
          arguments: { ticketId: "T-123" },
        }),
      ).resolves.toMatchObject({
        structuredContent: {
          category: "billing",
          confidence: 0.9,
        },
      });
    } finally {
      await client.close();
    }

    expect(stderr).toBe("");
  });

  it("serves authenticated stateless HTTP and keeps authorization in the capability", async () => {
    const token = "test-only-support-token";
    const child = spawn(process.execPath, ["dist/mcp-http.js"], {
      cwd: exampleRoot,
      env: {
        ...process.env,
        SUPPORT_ENGINE_BEARER_TOKEN: token,
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
      const url = new URL(`http://127.0.0.1:${port}/mcp`);
      const requestBody = JSON.stringify({
        jsonrpc: "2.0",
        id: "auth-boundary",
        method: "tools/call",
        params: {
          name: toolName,
          arguments: { ticketId: "T-123" },
        },
      });
      const headers = {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      };

      const missing = await fetch(url, {
        method: "POST",
        headers,
        body: requestBody,
      });
      const invalid = await fetch(url, {
        method: "POST",
        headers: { ...headers, authorization: "Bearer invalid" },
        body: requestBody,
      });
      expect(missing.status).toBe(401);
      expect(invalid.status).toBe(401);
      await Promise.all([missing.arrayBuffer(), invalid.arrayBuffer()]);

      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: {
          headers: { authorization: `Bearer ${token}` },
        },
      });
      client = new Client(
        { name: "support-http-entrypoint-test", version: "0.0.0-test" },
        { capabilities: {} },
      );
      await client.connect(transport as unknown as Transport);
      await expect(
        client.callTool({
          name: toolName,
          arguments: { ticketId: "T-123" },
        }),
      ).resolves.toMatchObject({
        structuredContent: {
          category: "billing",
          confidence: 0.9,
        },
      });

      const forbidden = await client.callTool({
        name: toolName,
        arguments: {
          ticketId: "T-999",
          principal: {
            id: "attacker",
            attributes: { allowedTicketIds: ["T-999"] },
          },
        },
      });
      expect(forbidden.isError).toBe(true);
      expect(toolErrorPayload(forbidden)).toMatchObject({ code: "FORBIDDEN" });
    } finally {
      await client?.close().catch(() => undefined);
      await stopProcess(child);
    }

    expect(stdout).toBe("");
    expect(stderr).not.toContain(token);
    expect(stderr).not.toContain("attacker");
  });
});
