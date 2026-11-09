import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  connectMcpClient,
  type McpClientConnection,
  McpClientError,
} from "../src/index.js";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const fixturePath = fileURLToPath(
  new URL("./fixtures/stdio-visibility-server.mjs", import.meta.url),
);
const connections: McpClientConnection[] = [];

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
    { cwd: repositoryRoot },
  );
});

afterEach(async () => {
  await Promise.allSettled(
    connections.splice(0).map((connection) => connection.close()),
  );
});

describe("MCP stdio capability visibility", () => {
  it("lists and serves only what the host principal may see", async () => {
    const connection = await connectMcpClient({
      transport: "stdio",
      command: process.execPath,
      args: [fixturePath],
      cwd: repositoryRoot,
    });
    connections.push(connection);

    expect(
      (await connection.listTools()).tools.map((tool) => tool.name),
    ).toEqual(["billing_get-invoice"]);
    await expect(
      connection.callTool("billing_get-invoice", {}),
    ).resolves.toMatchObject({
      response: { structuredContent: { ok: true } },
    });
    const hidden = await connection
      .callTool("billing_refund", {})
      .catch((error: unknown) => error);
    const missing = await connection
      .callTool("billing_missing", {})
      .catch((error: unknown) => error);
    expect(hidden).toBeInstanceOf(McpClientError);
    expect((hidden as McpClientError).code).toBe(
      (missing as McpClientError).code,
    );
    expect((hidden as McpClientError).message).toBe(
      (missing as McpClientError).message,
    );
  });
});
