import {
  createServer,
  type IncomingMessage,
  type Server as NodeHttpServer,
  type RequestListener,
} from "node:http";

import { createEngine, defineCapability } from "@invokta/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  connectMcpClient,
  type McpClientConnection,
  type McpHttpServerHandle,
  serveMcpHttp,
} from "../src/index.js";

const connections: McpClientConnection[] = [];
const mcpServers: McpHttpServerHandle[] = [];
const nodeServers: NodeHttpServer[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(
    connections.splice(0).map((connection) => connection.close()),
  );
  await Promise.allSettled(
    mcpServers.splice(0).map((server) => server.close()),
  );
  await Promise.allSettled(
    nodeServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

const engine = createEngine({
  name: "client-http-fixture",
  version: "2.0.0",
  capabilities: {
    "fixture.echo": defineCapability({
      title: "Echo fixture",
      description: "Returns the authenticated HTTP invocation.",
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string(), principalId: z.string() }),
      access: "authenticated",
      async run({ input, context }) {
        return {
          value: input.value,
          principalId: context.principal?.id ?? "missing",
        };
      },
    }),
    "fixture.error": defineCapability({
      description: "Returns a tool-level execution error.",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      access: "authenticated",
      async run() {
        throw new Error("private fixture failure");
      },
    }),
    "fixture.wait": defineCapability({
      description: "Waits until the HTTP request is disconnected.",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      access: "authenticated",
      async run({ context }) {
        return await new Promise((resolve) => {
          const cancelled = () => resolve({ ok: false });
          if (context.signal.aborted) cancelled();
          else
            context.signal.addEventListener("abort", cancelled, { once: true });
        });
      },
    }),
  },
});

async function startHttpServer(): Promise<{
  readonly url: string;
  readonly connection: (
    authentication: Parameters<typeof connectMcpClient>[0],
  ) => Promise<McpClientConnection>;
}> {
  const server = await serveMcpHttp(engine, {
    port: 0,
    auth: {
      mode: "required",
      authenticate(request) {
        const bearer = request.headers.get("authorization");
        const custom = request.headers.get("x-api-key");
        if (bearer === "Bearer correct") return { id: "bearer-user" };
        if (custom === "custom-secret") return { id: "header-user" };
        return null;
      },
    },
  });
  mcpServers.push(server);
  const address = server.address();
  const url = `http://${address.host}:${address.port}/mcp`;
  return {
    url,
    async connection(target) {
      const connection = await connectMcpClient(target);
      connections.push(connection);
      return connection;
    },
  };
}

async function listenNodeServer(
  handler: RequestListener,
): Promise<{ readonly server: NodeHttpServer; readonly url: string }> {
  const server = createServer(handler);
  nodeServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The HTTP client fixture did not bind.");
  }
  return { server, url: `http://127.0.0.1:${address.port}/mcp` };
}

async function readRequestBody(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
    string,
    unknown
  >;
}

describe("plain MCP client facade over Streamable HTTP", () => {
  it("initializes, lists, and manually calls through bearer authentication", async () => {
    const fixture = await startHttpServer();
    const connection = await fixture.connection({
      transport: "http",
      url: fixture.url,
      authentication: { type: "bearer", token: "correct" },
    });

    expect(connection.server).toMatchObject({
      name: "client-http-fixture",
      version: "2.0.0",
      protocolVersion: "2025-11-25",
      capabilities: { tools: {} },
    });
    await expect(connection.listTools()).resolves.toMatchObject({
      tools: [
        { name: "fixture.echo", title: "Echo fixture" },
        { name: "fixture.error" },
        { name: "fixture.wait" },
      ],
    });
    await expect(
      connection.callTool("fixture.echo", { value: "hello" }),
    ).resolves.toMatchObject({
      response: {
        structuredContent: { value: "hello", principalId: "bearer-user" },
      },
    });
    await expect(
      connection.callTool("fixture.error", {}),
    ).resolves.toMatchObject({
      response: { isError: true },
    });
  });

  it("supports explicit custom authentication headers", async () => {
    const fixture = await startHttpServer();
    const connection = await fixture.connection({
      transport: "http",
      url: fixture.url,
      authentication: {
        type: "headers",
        headers: { "X-Api-Key": "custom-secret" },
      },
    });

    await expect(
      connection.callTool("fixture.echo", { value: "custom" }),
    ).resolves.toMatchObject({
      response: {
        structuredContent: { value: "custom", principalId: "header-user" },
      },
    });
  });

  it("does not open the SDK optional GET/SSE channel", async () => {
    const observedMethods: string[] = [];
    const platformFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      observedMethods.push(init?.method ?? "GET");
      return platformFetch(input, init);
    });
    const fixture = await startHttpServer();
    const connection = await fixture.connection({
      transport: "http",
      url: fixture.url,
      authentication: { type: "bearer", token: "correct" },
    });

    await connection.listTools();
    expect(observedMethods).not.toContain("GET");
  });

  it("aborts an active request before HTTP close resolves", async () => {
    const fixture = await startHttpServer();
    const connection = await fixture.connection({
      transport: "http",
      url: fixture.url,
      authentication: { type: "bearer", token: "correct" },
    });
    const call = connection.callTool("fixture.wait", {});
    const closing = connection.close();

    await expect(call).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(closing).resolves.toBeUndefined();
  });

  it("maps 401 and 403 without exposing a URL or credential", async () => {
    const fixture = await startHttpServer();
    const failure = await connectMcpClient({
      transport: "http",
      url: fixture.url,
      authentication: { type: "bearer", token: "canary-secret" },
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "AUTHENTICATION_FAILED",
      message: "The MCP target rejected the supplied credentials.",
    });
    const serialized = JSON.stringify(failure);
    expect(serialized).not.toContain("canary-secret");
    expect(serialized).not.toContain(fixture.url);
  });

  it("rejects redirects instead of following them", async () => {
    let redirected = false;
    const destination = createServer((_request, response) => {
      redirected = true;
      response.writeHead(500);
      response.end();
    });
    nodeServers.push(destination);
    await new Promise<void>((resolve) =>
      destination.listen(0, "127.0.0.1", resolve),
    );
    const destinationAddress = destination.address();
    if (destinationAddress === null || typeof destinationAddress === "string") {
      throw new Error("The redirect fixture did not bind.");
    }

    const redirect = createServer((_request, response) => {
      response.writeHead(302, {
        location: `http://127.0.0.1:${destinationAddress.port}/mcp`,
      });
      response.end();
    });
    nodeServers.push(redirect);
    await new Promise<void>((resolve) =>
      redirect.listen(0, "127.0.0.1", resolve),
    );
    const redirectAddress = redirect.address();
    if (redirectAddress === null || typeof redirectAddress === "string") {
      throw new Error("The redirect fixture did not bind.");
    }

    await expect(
      connectMcpClient({
        transport: "http",
        url: `http://127.0.0.1:${redirectAddress.port}/mcp`,
      }),
    ).rejects.toMatchObject({ code: "CONNECTION_FAILED" });
    expect(redirected).toBe(false);
  });

  it("rejects invalid UTF-8 in an HTTP protocol response", async () => {
    const fixture = await listenNodeServer(async (request, response) => {
      const message = await readRequestBody(request);
      if (message.method !== "initialize") {
        response.writeHead(202);
        response.end();
        return;
      }
      const prefix = Buffer.from(
        `{"jsonrpc":"2.0","id":${JSON.stringify(message.id)},"result":{"protocolVersion":"2025-11-25","capabilities":{},"serverInfo":{"name":"invalid-`,
      );
      const suffix = Buffer.from('","version":"1.0.0"}}}');
      response.writeHead(200, { "content-type": "application/json" });
      response.end(Buffer.concat([prefix, Buffer.from([0xc3, 0x28]), suffix]));
    });

    await expect(
      connectMcpClient({ transport: "http", url: fixture.url }),
    ).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  });

  it("accepts a valid UTF-8 code point split across HTTP chunks", async () => {
    const fixture = await listenNodeServer(async (request, response) => {
      const message = await readRequestBody(request);
      if (message.method !== "initialize") {
        response.writeHead(202);
        response.end();
        return;
      }
      const prefix = Buffer.from(
        `{"jsonrpc":"2.0","id":${JSON.stringify(message.id)},"result":{"protocolVersion":"2025-11-25","capabilities":{},"serverInfo":{"name":"caf`,
      );
      const suffix = Buffer.from('","version":"1.0.0"}}}');
      response.writeHead(200, { "content-type": "application/json" });
      response.write(Buffer.concat([prefix, Buffer.from([0xc3])]));
      await new Promise<void>((resolve) => setImmediate(resolve));
      response.end(Buffer.concat([Buffer.from([0xa9]), suffix]));
    });

    const connection = await connectMcpClient({
      transport: "http",
      url: fixture.url,
    });
    connections.push(connection);
    expect(connection.server.name).toBe("café");
  });

  it("preserves LIMIT_EXCEEDED for a streamed HTTP response over the boundary", async () => {
    let responseClosed = false;
    const fixture = await listenNodeServer(async (request, response) => {
      await readRequestBody(request);
      response.once("close", () => {
        responseClosed = true;
      });
      response.writeHead(200, { "content-type": "application/json" });
      for (let index = 0; index < 10; index += 1) {
        response.write("x".repeat(1024 * 1024));
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      response.write("x");
    });

    await expect(
      connectMcpClient({ transport: "http", url: fixture.url }),
    ).rejects.toMatchObject({
      code: "LIMIT_EXCEEDED",
      message: "The MCP client message limit was exceeded.",
    });
    await vi.waitFor(() => expect(responseClosed).toBe(true));
  });
});
