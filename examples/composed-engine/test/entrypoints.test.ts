import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { beforeAll, describe, expect, it, vi } from "vitest";

const exampleRoot = fileURLToPath(new URL("..", import.meta.url));
const atomicCapabilityId = "operations.classify-ticket";
const libraryCapabilityId = "operations.draft-reply";
const effectiveIds = [
  "operations.generate-report",
  "community.score-ticket-priority",
  "operations.classify-ticket",
  "community.search-knowledge-base",
  "operations.draft-reply",
];
const draftReply = {
  subject: "Re: Duplicate invoice",
  body: "Dear customer, We recommend these articles: Requesting a duplicate charge refund, Reading an invoice.",
  citedArticleIds: ["KB-1", "KB-3"],
};

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

describe("composed engine entrypoints", () => {
  it("runs an atomic and a library capability directly with result-only stdout", () => {
    const result = run("direct");

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      classification: {
        category: "billing",
        confidence: 0.9,
        rationale: "The ticket contains language associated with billing.",
      },
      reply: draftReply,
    });
  });

  it("lists, describes, and runs effective IDs through the CLI", () => {
    const listed = run("cli", ["list"]);
    expect(listed.status).toBe(0);
    expect(listed.stderr).toBe("");
    expect(
      (JSON.parse(listed.stdout) as ReadonlyArray<{ readonly id: string }>).map(
        (summary) => summary.id,
      ),
    ).toEqual(effectiveIds);

    const described = run("cli", ["describe", atomicCapabilityId]);
    expect(described.status).toBe(0);
    expect(JSON.parse(described.stdout)).toMatchObject({
      id: atomicCapabilityId,
      title: "Classify ticket",
    });

    const executed = run("cli", [
      "run",
      libraryCapabilityId,
      "--input",
      JSON.stringify({ ticketId: "T-123" }),
    ]);
    expect(executed.status).toBe(0);
    expect(executed.stderr).toBe("");
    expect(JSON.parse(executed.stdout)).toEqual(draftReply);
  });

  it("rejects a remapped default ID through the CLI", () => {
    const removed = run("cli", [
      "run",
      "community.draft-reply",
      "--input",
      JSON.stringify({ ticketId: "T-123" }),
    ]);

    expect(removed.status).toBe(1);
    expect(removed.stdout).toBe("");
    expect(JSON.parse(removed.stderr)).toMatchObject({
      error: { code: "CAPABILITY_NOT_FOUND" },
    });
  });

  it("serves the effective IDs as MCP tools over protocol-only stdio", async () => {
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
      { name: "composed-stdio-entrypoint-test", version: "0.0.0-test" },
      { capabilities: {} },
    );

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(effectiveIds);

      await expect(
        client.callTool({
          name: atomicCapabilityId,
          arguments: { ticketId: "T-456" },
        }),
      ).resolves.toMatchObject({
        structuredContent: { category: "technical", confidence: 0.9 },
      });
      await expect(
        client.callTool({
          name: libraryCapabilityId,
          arguments: { ticketId: "T-123" },
        }),
      ).resolves.toMatchObject({ structuredContent: draftReply });

      await expect(
        client.callTool({
          name: "community.draft-reply",
          arguments: { ticketId: "T-123" },
        }),
      ).rejects.toThrowError(/Tool community\.draft-reply not found/u);
    } finally {
      await client.close();
    }

    expect(stderr).toBe("");
  });

  it("serves authenticated stateless HTTP for atomic and library capabilities", async () => {
    const token = "test-only-composed-token";
    const child = spawn(process.execPath, ["dist/mcp-http.js"], {
      cwd: exampleRoot,
      env: {
        ...process.env,
        COMPOSED_ENGINE_BEARER_TOKEN: token,
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
            name: libraryCapabilityId,
            arguments: { ticketId: "T-123" },
          },
        }),
      });
      expect(unauthenticated.status).toBe(401);
      await unauthenticated.arrayBuffer();

      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      });
      client = new Client(
        { name: "composed-http-entrypoint-test", version: "0.0.0-test" },
        { capabilities: {} },
      );
      await client.connect(transport as unknown as Transport);

      await expect(
        client.callTool({
          name: "community.score-ticket-priority",
          arguments: { ticketId: "T-789" },
        }),
      ).resolves.toMatchObject({
        structuredContent: { priority: "urgent", weight: 8 },
      });
      await expect(
        client.callTool({
          name: libraryCapabilityId,
          arguments: { ticketId: "T-123" },
        }),
      ).resolves.toMatchObject({ structuredContent: draftReply });

      const forbidden = await client.callTool({
        name: atomicCapabilityId,
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
