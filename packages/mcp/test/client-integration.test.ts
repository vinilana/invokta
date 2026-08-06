import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  connectMcpClient,
  type McpClientConnection,
  type McpJsonValue,
} from "../src/index.js";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const fixturePath = fileURLToPath(
  new URL("./fixtures/client-stdio-server.mjs", import.meta.url),
);
const connections: McpClientConnection[] = [];
const messageLimit = 10 * 1024 * 1024;

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

async function connectStdio(): Promise<McpClientConnection> {
  const connection = await connectMcpClient({
    transport: "stdio",
    command: process.execPath,
    args: [fixturePath, "", "--exact", "space value"],
    cwd: repositoryRoot,
    env: { FACADE_EXPLICIT: "configured" },
  });
  connections.push(connection);
  return connection;
}

describe("plain MCP client facade over stdio", () => {
  it("initializes, exposes plain server information, and follows exact cursors", async () => {
    const connection = await connectStdio();

    expect(connection.server).toEqual({
      name: "client-facade-fixture",
      version: "1.2.3",
      protocolVersion: "2025-11-25",
      instructions: "Use only explicit fixture calls.",
      capabilities: { tools: {} },
    });
    const firstPage = await connection.listTools();
    expect(firstPage.nextCursor).toBe("");
    expect(firstPage.tools).toEqual([
      {
        name: "fixture.inspect",
        title: "Inspect fixture",
        description: "Returns the exact child launch observations.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: true,
        },
        annotations: {
          readOnlyHint: true,
        },
      },
    ]);
    const secondPage = await connection.listTools(firstPage.nextCursor);
    expect(secondPage.nextCursor).toBeUndefined();
    expect(secondPage.tools.map((tool) => tool.name)).toEqual([
      "fixture.wait",
      "fixture.error",
      "fixture.large",
    ]);
  });

  it("uses exact arguments and only the SDK safe environment plus the overlay", async () => {
    process.env.FACADE_CANARY = "must-not-reach-child";
    try {
      const connection = await connectStdio();
      const result = await connection.callTool("fixture.inspect", {
        value: "ok",
      });
      const structured = result.response.structuredContent as Record<
        string,
        unknown
      >;
      expect(structured.arguments).toEqual(["", "--exact", "space value"]);
      expect(structured.value).toBe("ok");
      expect(structured.explicitEnvironment).toBe("configured");
      expect(structured.environmentKeys).toContain("FACADE_EXPLICIT");
      expect(structured.environmentKeys).not.toContain("FACADE_CANARY");
    } finally {
      delete process.env.FACADE_CANARY;
    }
  });

  it("preserves tool-level isError results", async () => {
    const connection = await connectStdio();
    await expect(connection.callTool("fixture.error")).resolves.toMatchObject({
      response: { isError: true },
    });
  });

  it("snapshots call arguments before asynchronous protocol work", async () => {
    const connection = await connectStdio();
    const argumentsValue = { value: "before" };
    const call = connection.callTool("fixture.inspect", argumentsValue);
    argumentsValue.value = "after";

    await expect(call).resolves.toMatchObject({
      response: { structuredContent: { value: "before" } },
    });
  });

  it("preserves own __proto__ JSON data without changing snapshot prototypes", async () => {
    const connection = await connectStdio();
    const hostileValue = Object.create(null) as Record<string, McpJsonValue>;
    Object.defineProperty(hostileValue, "__proto__", {
      enumerable: true,
      value: { polluted: true },
    });

    const result = await connection.callTool("fixture.inspect", {
      value: hostileValue,
    });
    const structured = result.response.structuredContent as Record<
      string,
      unknown
    >;
    const returned = structured.value as Record<string, unknown>;

    expect(Object.hasOwn(returned, "__proto__")).toBe(true);
    expect(
      Reflect.getOwnPropertyDescriptor(returned, "__proto__")?.value,
    ).toEqual({ polluted: true });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("rejects non-lossless JSON call arguments without invoking accessors", async () => {
    const connection = await connectStdio();
    let reads = 0;
    const argumentsValue: Record<string, McpJsonValue> = {};
    Object.defineProperty(argumentsValue, "secret", {
      enumerable: true,
      get() {
        reads += 1;
        return "must-not-be-read";
      },
    });

    await expect(
      connection.callTool("fixture.inspect", argumentsValue),
    ).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    expect(reads).toBe(0);
    await expect(connection.listTools()).resolves.toMatchObject({
      nextCursor: "",
    });
  });

  it("accepts the exact stdio message boundary and rejects the next byte", async () => {
    const connection = await connectStdio();
    const emptyMessage = `${JSON.stringify({
      method: "tools/call",
      params: {
        name: "fixture.inspect",
        arguments: { data: "" },
      },
      jsonrpc: "2.0",
      id: 1,
    })}\n`;
    const exactData = "x".repeat(
      messageLimit - Buffer.byteLength(emptyMessage),
    );

    await expect(
      connection.callTool("fixture.inspect", { data: exactData }),
    ).resolves.toMatchObject({ response: { structuredContent: {} } });
    await expect(
      connection.callTool("fixture.inspect", { data: `${exactData}x` }),
    ).rejects.toMatchObject({
      code: "LIMIT_EXCEEDED",
      message: "The MCP client message limit was exceeded.",
    });
    await expect(connection.listTools()).rejects.toMatchObject({
      code: "CANCELLED",
    });
  });

  it("rejects an encoded response that crosses the message boundary", async () => {
    const connection = await connectStdio();

    await expect(connection.callTool("fixture.large")).rejects.toMatchObject({
      code: "LIMIT_EXCEEDED",
      message: "The MCP client message limit was exceeded.",
    });
    await expect(connection.listTools()).rejects.toMatchObject({
      code: "CANCELLED",
    });
  });

  it("cancels only the current operation and keeps the connection usable", async () => {
    const connection = await connectStdio();
    const controller = new AbortController();
    const call = connection.callTool("fixture.wait", undefined, {
      signal: controller.signal,
    });
    controller.abort();

    await expect(call).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(connection.listTools()).resolves.toMatchObject({
      nextCursor: "",
    });
  });

  it("settles active work when an idempotent close begins", async () => {
    const connection = await connectStdio();
    const call = connection.callTool("fixture.wait");
    const firstClose = connection.close();
    const secondClose = connection.close();

    expect(secondClose).toBe(firstClose);
    await expect(call).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(firstClose).resolves.toBeUndefined();
  });

  it("maps an executable start failure to a sanitized plain error", async () => {
    const failure = await connectMcpClient({
      transport: "stdio",
      command: "invokta-command-that-does-not-exist",
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "SPAWN_FAILED",
      message: "The MCP server process could not be started.",
    });
    expect(JSON.stringify(failure)).not.toContain("invokta-command");
  });
});
