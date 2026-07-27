import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { beforeAll, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const fixturePath = fileURLToPath(
  new URL("./fixtures/stdio-server.mjs", import.meta.url),
);

beforeAll(() => {
  execFileSync(
    process.execPath,
    [
      "node_modules/typescript/bin/tsc",
      "-b",
      "packages/core",
      "packages/mcp",
      "--pretty",
      "false",
    ],
    { cwd: repositoryRoot, stdio: "pipe" },
  );
});

it("serves handshake, tools/list, and tools/call over protocol-only stdio", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fixturePath],
    cwd: repositoryRoot,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });
  const client = new Client(
    { name: "stdio-child-process-test", version: "0.0.0-test" },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);
    expect(client.getServerVersion()).toEqual({
      name: "stdio-smoke-engine",
      version: "0.1.0",
    });
    await expect(client.listTools()).resolves.toMatchObject({
      tools: [
        {
          name: "example.inspect-context",
          description: "Returns the stdio execution boundary context.",
        },
      ],
    });
    await expect(
      client.callTool({
        name: "example.inspect-context",
        arguments: { value: "wire-ok" },
      }),
    ).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            value: "wire-ok",
            source: "mcp-stdio",
            anonymous: true,
          }),
        },
      ],
      structuredContent: {
        value: "wire-ok",
        source: "mcp-stdio",
        anonymous: true,
      },
    });
  } finally {
    await client.close();
  }

  expect(stderr).toBe("");
});
