import { execFileSync, spawn } from "node:child_process";
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

/** Sends raw JSON-RPC lines to the fixture and returns the responses by ID. */
async function rawExchange(
  messages: ReadonlyArray<Record<string, unknown>>,
  ids: ReadonlyArray<number>,
): Promise<Map<number, Record<string, unknown>>> {
  const child = spawn(process.execPath, [fixturePath], {
    cwd: repositoryRoot,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const responses = new Map<number, Record<string, unknown>>();
  let buffer = "";
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("stdio exchange timed out")),
        10_000,
      );
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const message = JSON.parse(buffer.slice(0, newline)) as Record<
            string,
            unknown
          >;
          buffer = buffer.slice(newline + 1);
          if (typeof message.id === "number")
            responses.set(message.id, message);
          newline = buffer.indexOf("\n");
        }
        if (ids.every((id) => responses.has(id))) {
          clearTimeout(timer);
          resolve();
        }
      });
      for (const message of messages) {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      }
    });
  } finally {
    child.stdin.end();
    child.kill();
  }
  return responses;
}

describe("MCP stdio capability visibility", () => {
  it("answers a hidden tool with the same protocol error as an unknown one", async () => {
    const call = (id: number, name: string) => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: {} },
    });
    const responses = await rawExchange(
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "raw-test", version: "0.0.0" },
          },
        },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        call(2, "billing_refund"),
        call(3, "billing_missing"),
      ],
      [1, 2, 3],
    );

    const hidden = responses.get(2)?.error as { code: number; message: string };
    const missing = responses.get(3)?.error as {
      code: number;
      message: string;
    };
    expect(hidden.code).toBe(missing.code);
    expect(hidden.message.replace("billing_refund", "<tool>")).toBe(
      missing.message.replace("billing_missing", "<tool>"),
    );
    expect(responses.get(2)?.result).toBeUndefined();
  });

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
