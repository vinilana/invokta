import { expect, it } from "vitest";

import {
  connectMcpClient,
  McpClientError,
  type McpClientTarget,
} from "../src/index.js";

async function expectInvalidTarget(target: McpClientTarget): Promise<void> {
  const rejection = await connectMcpClient(target).catch(
    (error: unknown) => error,
  );
  expect(rejection).toBeInstanceOf(McpClientError);
  expect(rejection).toMatchObject({
    code: "INVALID_TARGET",
    message: "The MCP client target is invalid.",
  });
  expect(Object.keys(rejection as object)).toEqual(["code", "message"]);
  expect(JSON.stringify(rejection)).toBe(
    '{"code":"INVALID_TARGET","message":"The MCP client target is invalid."}',
  );
}

it.each([
  { transport: "stdio", command: "", args: [] },
  { transport: "stdio", command: "server", env: { TOKEN: "" } },
  { transport: "http", url: "http://localhost/mcp" },
  { transport: "http", url: "http://127.0.0.2/mcp" },
  { transport: "http", url: "https://user@example.com/mcp" },
  { transport: "http", url: "https://example.com/mcp?secret=value" },
  { transport: "http", url: "https://example.com/mcp#fragment" },
  {
    transport: "http",
    url: "https://example.com/mcp",
    authentication: { type: "bearer", token: " token" },
  },
  {
    transport: "http",
    url: "https://example.com/mcp",
    authentication: {
      type: "headers",
      headers: { Cookie: "secret" },
    },
  },
  {
    transport: "http",
    url: "https://example.com/mcp",
    authentication: {
      type: "headers",
      headers: { Accept: "application/json" },
    },
  },
  {
    transport: "http",
    url: "https://example.com/mcp",
    authentication: {
      type: "headers",
      headers: { "content-TYPE": "application/json" },
    },
  },
  {
    transport: "http",
    url: "https://example.com/mcp",
    authentication: {
      type: "headers",
      headers: { "Mcp-Protocol-Version": "2025-11-25" },
    },
  },
  {
    transport: "http",
    url: "https://example.com/mcp",
    authentication: {
      type: "headers",
      headers: { "Last-Event-ID": "secret" },
    },
  },
  {
    transport: "http",
    url: "https://example.com/mcp",
    authentication: {
      type: "headers",
      headers: { "X-Token": "secret\r\ninjected: true" },
    },
  },
] as const)("rejects an invalid target before I/O: %j", expectInvalidTarget);

it("rejects accessor-backed targets without invoking the accessor", async () => {
  let reads = 0;
  const target = { transport: "http" } as Record<string, unknown>;
  Object.defineProperty(target, "url", {
    enumerable: true,
    get() {
      reads += 1;
      return "https://example.com/mcp";
    },
  });

  await expectInvalidTarget(target as McpClientTarget);
  expect(reads).toBe(0);
});

it("rejects a pre-aborted initialization without starting the target", async () => {
  const controller = new AbortController();
  controller.abort();

  await expect(
    connectMcpClient(
      { transport: "stdio", command: "must-not-be-started" },
      { signal: controller.signal },
    ),
  ).rejects.toMatchObject({
    code: "CANCELLED",
    message: "The MCP client operation was cancelled.",
  });
});
