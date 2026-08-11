import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const exampleRoot = fileURLToPath(new URL("..", import.meta.url));
const listRootsId = "knowledge.list-context-roots";
const openNodeId = "knowledge.open-context-node";
const listRootsToolName = "knowledge_list-context-roots";
const openNodeToolName = "knowledge_open-context-node";
let vaultPath: string;

beforeAll(async () => {
  vaultPath = await mkdtemp(join(tmpdir(), "obsidian-entrypoint-test-"));
  await mkdir(join(vaultPath, "indexes"));
  await mkdir(join(vaultPath, "guides"));
  await writeFile(
    join(vaultPath, "indexes", "architecture.md"),
    `---
id: architecture
kind: index
entrypoint: true
title: Architecture
summary: System boundaries
---
# Architecture

Start with [[Capability contracts]].
`,
    "utf8",
  );
  await writeFile(
    join(vaultPath, "guides", "capability-contracts.md"),
    `---
id: capability-contracts
kind: guide
title: Capability contracts
indexes: [architecture]
---
# Capability contracts

Use explicit contracts for every capability.
`,
    "utf8",
  );
  const build = spawnSync(
    process.execPath,
    ["../../node_modules/typescript/bin/tsc", "-b", "--pretty", "false"],
    { cwd: exampleRoot, encoding: "utf8" },
  );
  if (build.status !== 0) {
    throw new Error(`Example build failed:\n${build.stdout}${build.stderr}`);
  }
});

afterAll(async () => {
  await rm(vaultPath, { recursive: true, force: true });
});

function environment(
  overrides: Readonly<Record<string, string | undefined>> = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OBSIDIAN_VAULT_PATH: vaultPath,
    ...overrides,
  };
}

function run(entrypoint: string, args: readonly string[] = []) {
  return spawnSync(process.execPath, [`dist/${entrypoint}.js`, ...args], {
    cwd: exampleRoot,
    env: environment(),
    encoding: "utf8",
  });
}

async function stopProcess(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill();
  await exited;
}

describe("Obsidian context engine entrypoints", () => {
  it("lists roots and progressively opens a selected node directly", () => {
    const listed = run("direct");
    expect(listed.status).toBe(0);
    expect(listed.stderr).toBe("");
    expect(JSON.parse(listed.stdout)).toMatchObject({
      roots: [
        {
          id: "architecture",
          frontmatter: {
            kind: "index",
            entrypoint: true,
            summary: "System boundaries",
          },
        },
      ],
    });

    const opened = run("direct", ["capability-contracts"]);
    expect(opened.status).toBe(0);
    expect(opened.stderr).toBe("");
    expect(JSON.parse(opened.stdout)).toMatchObject({
      found: true,
      node: {
        id: "capability-contracts",
        content:
          "# Capability contracts\n\nUse explicit contracts for every capability.\n",
      },
      relatedIndexes: [{ id: "architecture" }],
    });
  });

  it("publishes the graph navigation capabilities through the CLI", () => {
    const listed = run("cli", ["list"]);
    expect(listed.status).toBe(0);
    expect(
      (JSON.parse(listed.stdout) as ReadonlyArray<{ id: string }>).map(
        ({ id }) => id,
      ),
    ).toEqual([listRootsId, openNodeId]);

    const result = run("cli", [
      "run",
      openNodeId,
      "--input",
      '{"id":"capability-contracts"}',
    ]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      found: true,
      node: { id: "capability-contracts" },
      relatedIndexes: [{ id: "architecture" }],
    });
  });

  it("fails closed when the vault path is not configured", () => {
    const result = spawnSync(process.execPath, ["dist/cli.js", "list"], {
      cwd: exampleRoot,
      env: environment({ OBSIDIAN_VAULT_PATH: "" }),
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      error: {
        code: "EXECUTION_FAILED",
        message: "Obsidian context engine CLI startup failed.",
      },
    });
  });

  it("serves graph navigation over protocol-only MCP stdio", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["dist/mcp-stdio.js"],
      cwd: exampleRoot,
      env: environment() as Record<string, string>,
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    const client = new Client(
      { name: "obsidian-stdio-test", version: "0.0.0-test" },
      { capabilities: {} },
    );

    try {
      await client.connect(transport);
      await expect(client.listTools()).resolves.toMatchObject({
        tools: [{ name: listRootsToolName }, { name: openNodeToolName }],
      });
      await expect(
        client.callTool({
          name: openNodeToolName,
          arguments: { id: "capability-contracts" },
        }),
      ).resolves.toMatchObject({
        structuredContent: {
          found: true,
          node: { id: "capability-contracts" },
          relatedIndexes: [{ id: "architecture" }],
        },
      });
    } finally {
      await client.close();
    }

    expect(stderr).toBe("");
  });

  it("serves authenticated stateless MCP HTTP without exposing credentials or vault contents in diagnostics", async () => {
    const token = "test-only-obsidian-token";
    const child = spawn(process.execPath, ["dist/mcp-http.js"], {
      cwd: exampleRoot,
      env: environment({
        OBSIDIAN_ENGINE_BEARER_TOKEN: token,
        PORT: "0",
      }),
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
          params: { name: listRootsToolName, arguments: {} },
        }),
      });
      expect(unauthenticated.status).toBe(401);
      await unauthenticated.arrayBuffer();

      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      });
      client = new Client(
        { name: "obsidian-http-test", version: "0.0.0-test" },
        { capabilities: {} },
      );
      await client.connect(transport as unknown as Transport);
      await expect(
        client.callTool({ name: listRootsToolName, arguments: {} }),
      ).resolves.toMatchObject({
        structuredContent: {
          roots: [{ id: "architecture" }],
        },
      });
    } finally {
      await client?.close().catch(() => undefined);
      await stopProcess(child);
    }

    expect(stdout).toBe("");
    expect(stderr).not.toContain(token);
    expect(stderr).not.toContain("Use explicit contracts");
    expect(stderr).not.toContain(vaultPath);
  });
});
