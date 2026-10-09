import { createServer, type IncomingHttpHeaders } from "node:http";

import * as mcp from "@invokta/mcp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runParallelCommand } from "../src/parallel-search.js";

interface RequestRecord {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly message: Record<string, unknown>;
}

const cleanup: (() => Promise<void>)[] = [];
const connect = mcp.connectMcpClient;
const closeSpies: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
  vi.spyOn(mcp, "connectMcpClient").mockImplementation(async (...args) => {
    const connection = await connect(...args);
    closeSpies.push(vi.spyOn(connection, "close"));
    return connection;
  });
});
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
  for (const close of closeSpies.splice(0))
    expect(close).toHaveBeenCalledOnce();
  vi.restoreAllMocks();
});

async function fixture(
  options: {
    readonly missingTool?: boolean;
    readonly toolError?: boolean;
    readonly wait?: boolean;
    readonly repeatCursor?: boolean;
  } = {},
) {
  const requests: RequestRecord[] = [];
  const response = {
    content: [{ type: "text", text: "Example Domain: https://example.com/" }],
    ...(options.toolError ? { isError: true } : {}),
  };
  let callStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    callStarted = resolve;
  });
  const server = createServer(async (request, reply) => {
    if (request.method !== "POST") {
      requests.push({
        method: request.method ?? "",
        path: request.url ?? "",
        headers: request.headers,
        message: {},
      });
      reply.writeHead(request.method === "DELETE" ? 200 : 405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(
      Buffer.concat(chunks).toString("utf8"),
    ) as Record<string, unknown>;
    requests.push({
      method: "POST",
      path: request.url ?? "",
      headers: request.headers,
      message,
    });
    if (message.id === undefined) {
      reply.writeHead(202).end();
      return;
    }
    let result: unknown;
    const params = message.params as Record<string, unknown> | undefined;
    switch (message.method) {
      case "initialize":
        result = {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "parallel-fixture", version: "1.0.0" },
        };
        break;
      case "tools/list":
        result =
          params?.cursor === undefined || options.repeatCursor
            ? {
                tools: [{ name: "unrelated", inputSchema: { type: "object" } }],
                nextCursor: "page-2",
              }
            : {
                tools: options.missingTool
                  ? []
                  : ["web_search", "web_fetch"].map((name) => ({
                      name,
                      inputSchema: { type: "object" },
                    })),
              };
        break;
      case "tools/call":
        callStarted();
        if (options.wait) return;
        result = response;
        break;
      default:
        reply.writeHead(400).end();
        return;
    }
    reply.writeHead(200, {
      "Content-Type": "application/json",
      "Mcp-Session-Id": "fixture-session",
    });
    reply.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Fixture failed to bind.");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    requests,
    response,
    started,
  };
}

describe("Parallel Search MCP consumer", () => {
  it("accepts the 20-URL boundary and applies a 60-second deadline", async () => {
    const peer = await fixture();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const urls = Array.from({ length: 20 }, () => "https://example.com/");
    expect(
      await runParallelCommand(["fetch", ...urls], { url: peer.url }),
    ).toEqual(peer.response);
    expect(timeout).toHaveBeenCalledWith(60_000);
    const call = peer.requests.find(
      ({ message }) => message.method === "tools/call",
    );
    expect(call?.message.params).toEqual({
      name: "web_fetch",
      arguments: { urls },
    });
  });

  it.each([
    {
      args: [
        "search",
        "Find the example domain",
        "example domain website",
        "IANA example domain",
      ],
      name: "web_search",
      arguments: {
        objective: "Find the example domain",
        search_queries: ["example domain website", "IANA example domain"],
      },
    },
    {
      args: ["fetch", "https://example.com/"],
      name: "web_fetch",
      arguments: { urls: ["https://example.com/"] },
    },
  ])(
    "discovers and calls $name over anonymous HTTP with the project User-Agent",
    async ({ args, name, arguments: toolArguments }) => {
      const peer = await fixture();
      expect(await runParallelCommand(args, { url: peer.url })).toEqual(
        peer.response,
      );
      const messages = peer.requests
        .filter(({ method }) => method === "POST")
        .map(({ message }) => message);
      expect(
        messages
          .filter(({ method }) => method === "tools/list")
          .map(({ params }) => params),
      ).toEqual([undefined, { cursor: "page-2" }]);
      expect(
        messages
          .filter(({ method }) => method === "tools/call")
          .map(({ params }) => params),
      ).toEqual([{ name, arguments: toolArguments }]);
      for (const request of peer.requests) {
        expect(request.path).toBe("/mcp");
        expect(request.headers["user-agent"]).toBe(
          "invokta-parallel-search-example/0.1.0",
        );
        expect(request.headers.authorization).toBeUndefined();
        expect(request.headers["x-api-key"]).toBeUndefined();
        expect(request.headers.cookie).toBeUndefined();
      }
    },
  );

  it("preserves tool-level errors without retrying", async () => {
    const peer = await fixture({ toolError: true });
    expect(
      await runParallelCommand(["fetch", "https://example.com/"], {
        url: peer.url,
      }),
    ).toEqual(peer.response);
    expect(
      peer.requests.filter(({ message }) => message.method === "tools/call"),
    ).toHaveLength(1);
  });

  it("closes the client without dispatch when discovery lacks the requested tool", async () => {
    const peer = await fixture({ missingTool: true });
    await expect(
      runParallelCommand(["fetch", "https://example.com/"], { url: peer.url }),
    ).rejects.toThrow("Required MCP tool not found: web_fetch");
    expect(
      peer.requests.some(({ message }) => message.method === "tools/call"),
    ).toBe(false);
  });

  it("bounds tool discovery even if a peer repeats its cursor", async () => {
    const peer = await fixture({ repeatCursor: true });
    await expect(
      runParallelCommand(["fetch", "https://example.com/"], { url: peer.url }),
    ).rejects.toThrow("MCP tool discovery exceeded 20 pages.");
    expect(
      peer.requests.filter(({ message }) => message.method === "tools/list"),
    ).toHaveLength(20);
  });

  it("cancels an in-flight call and closes the client", async () => {
    const peer = await fixture({ wait: true });
    const abort = new AbortController();
    const pending = runParallelCommand(["fetch", "https://example.com/"], {
      url: peer.url,
      signal: abort.signal,
    });
    const cancelled = expect(pending).rejects.toMatchObject({
      code: "CANCELLED",
    });
    await peer.started;
    abort.abort();
    await cancelled;
  });

  it.each([
    [],
    ["search"],
    ["search", "objective"],
    ["search", "", "query"],
    ["search", "objective", " "],
    ["fetch"],
    ["fetch", "file:///etc/passwd"],
    ["fetch", "https://user:secret@example.com/"],
    ["fetch", ...Array.from({ length: 21 }, () => "https://example.com/")],
    ["unknown"],
  ])(
    "rejects invalid arguments before opening a connection: %j",
    async (...args) => {
      const peer = await fixture();
      await expect(runParallelCommand(args, { url: peer.url })).rejects.toThrow(
        "Usage:",
      );
      expect(peer.requests).toEqual([]);
    },
  );
});
