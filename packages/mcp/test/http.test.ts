import { request as httpRequest } from "node:http";
import { createConnection } from "node:net";

import {
  createEngine,
  defineCapability,
  type ExecutionContext,
} from "@ai-engine/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { type McpHttpServerHandle, serveMcpHttp } from "../src/index.js";

const openServers: McpHttpServerHandle[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

function createContextEngine(
  observeContext: (context: ExecutionContext) => void = () => undefined,
) {
  return createEngine({
    name: "http-test-engine",
    version: "0.1.0",
    capabilities: {
      "support.inspect": defineCapability({
        description: "Returns the authenticated HTTP execution context.",
        input: z.object({ value: z.string(), delayMs: z.number().optional() }),
        output: z.object({ value: z.string(), principalId: z.string() }),
        access: "authenticated",
        async run({ input, context }) {
          observeContext(context);
          if (input.delayMs !== undefined) {
            await new Promise((resolve) => setTimeout(resolve, input.delayMs));
          }
          return {
            value: input.value,
            principalId: context.principal?.id ?? "anonymous",
          };
        },
      }),
    },
  });
}

async function start(
  engine: Parameters<typeof serveMcpHttp>[0] = createContextEngine(),
  overrides: Partial<Parameters<typeof serveMcpHttp>[1]> = {},
) {
  const server = await serveMcpHttp(engine, {
    port: 0,
    auth: {
      mode: "required",
      async authenticate(request) {
        const token = request.headers.get("authorization");
        if (token === "Bearer invalid") return null;
        if (token === null) return null;
        return { id: `user:${token.slice("Bearer ".length)}` };
      },
    },
    ...overrides,
  });
  openServers.push(server);
  return server;
}

function endpoint(server: McpHttpServerHandle, path = "/mcp") {
  const address = server.address();
  return `http://${address.host}:${address.port}${path}`;
}

async function callTool(
  server: McpHttpServerHandle,
  options: {
    readonly id?: string;
    readonly token?: string;
    readonly arguments?: Readonly<Record<string, unknown>>;
    readonly headers?: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal;
  } = {},
) {
  return fetch(endpoint(server), {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(options.token === undefined
        ? {}
        : { authorization: `Bearer ${options.token}` }),
      ...options.headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: options.id ?? crypto.randomUUID(),
      method: "tools/call",
      params: {
        name: "support.inspect",
        arguments: options.arguments ?? { value: "ok" },
      },
    }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function callToolWithRawHost(
  server: McpHttpServerHandle,
  host: string,
): Promise<number | undefined> {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: address.host,
        port: address.port,
        path: "/mcp",
        method: "POST",
        headers: {
          host,
          authorization: "Bearer allowed",
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      },
    );
    request.once("error", reject);
    request.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "host-test",
        method: "tools/call",
        params: { name: "support.inspect", arguments: { value: "ok" } },
      }),
    );
  });
}

async function rawHttpStatus(
  server: McpHttpServerHandle,
  requestText: string,
): Promise<number> {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const socket = createConnection(address.port, address.host);
    let response = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.end(requestText));
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.once("end", () => {
      resolve(Number(response.match(/^HTTP\/1\.1 (\d{3})/u)?.[1]));
    });
    socket.once("error", reject);
  });
}

async function rawHttpResponseFromSlowBody(
  server: McpHttpServerHandle,
  requestHead: string,
): Promise<{ readonly response: string; readonly closed: boolean }> {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const socket = createConnection(address.port, address.host);
    let response = "";
    let settled = false;
    const finish = (closed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve({ response, closed });
    };
    const timeout = setTimeout(() => finish(false), 1_000);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${requestHead}x`));
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.once("end", () => finish(true));
    socket.once("close", () => finish(true));
    socket.once("error", reject);
  });
}

describe("MCP stateless Streamable HTTP", () => {
  it("binds to loopback by default and returns a neutral address handle", async () => {
    const server = await start();

    expect(server.address()).toMatchObject({
      host: "127.0.0.1",
      port: expect.any(Number),
    });
    expect(server.address().port).toBeGreaterThan(0);
  });

  it("authenticates before invoke and rejects missing or invalid credentials", async () => {
    const engine = createContextEngine();
    const invoke = vi.spyOn(engine, "invoke");
    const server = await start(engine);

    const missing = await callTool(server);
    const invalid = await callTool(server, { token: "invalid" });

    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe("Bearer");
    expect(invalid.headers.get("www-authenticate")).toBe("Bearer");
    expect(invoke).not.toHaveBeenCalled();
    expect(JSON.stringify(await json(invalid))).not.toContain("Invalid token");
  });

  it("sanitizes unexpected authentication infrastructure failures", async () => {
    const engine = createContextEngine();
    const invoke = vi.spyOn(engine, "invoke");
    const server = await start(engine, {
      auth: {
        mode: "required",
        async authenticate() {
          throw new Error("identity provider secret: top-secret");
        },
      },
    });

    const response = await callTool(server, { token: "alice" });
    const payload = await json(response);

    expect(response.status).toBe(500);
    expect(payload).toEqual({ error: "authentication_failed" });
    expect(JSON.stringify(payload)).not.toContain("top-secret");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects malformed authentication configuration before listening", async () => {
    await expect(
      serveMcpHttp(createContextEngine(), {
        port: 0,
        auth: { mode: "unexpected" } as never,
      }),
    ).rejects.toThrow("auth.mode");
    await expect(
      serveMcpHttp(createContextEngine(), {
        port: 0,
        auth: { mode: "required", authenticate: undefined } as never,
      }),
    ).rejects.toThrow("authenticate");
  });

  it("snapshots the required authentication hook before listening", async () => {
    const originalAuthenticate = vi.fn(() => ({ id: "user:original" }));
    const replacementAuthenticate = vi.fn(() => ({ id: "user:replacement" }));
    const auth = {
      mode: "required",
      authenticate: originalAuthenticate,
    } as {
      mode: string;
      authenticate: typeof originalAuthenticate;
    };
    const server = await start(createContextEngine(), { auth: auth as never });

    auth.mode = "dangerously-disabled-for-development";
    auth.authenticate = replacementAuthenticate;
    const response = await callTool(server, { token: "alice" });

    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
      result: { structuredContent: { principalId: "user:original" } },
    });
    expect(originalAuthenticate).toHaveBeenCalledOnce();
    expect(replacementAuthenticate).not.toHaveBeenCalled();
  });

  it("rejects malformed or non-cloneable principals before invoke", async () => {
    const engine = createContextEngine();
    const invoke = vi.spyOn(engine, "invoke");
    const principals = [
      { id: "" },
      { id: "user:array", attributes: [] },
      { id: "user:function", attributes: { unsafe: () => undefined } },
    ];
    const server = await start(engine, {
      auth: {
        mode: "required",
        authenticate: () => principals.shift() as never,
      },
    });

    const responses = await Promise.all([
      callTool(server, { token: "empty" }),
      callTool(server, { token: "array" }),
      callTool(server, { token: "function" }),
    ]);

    expect(responses.map(({ status }) => status)).toEqual([401, 401, 401]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("deeply snapshots a reused principal for each concurrent request", async () => {
    let firstStarted!: () => void;
    const didFirstStart = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const sharedPrincipal = {
      id: "user:initial",
      attributes: { tenant: "initial" },
    };
    const engine = createEngine({
      name: "principal-isolation-engine",
      version: "0.1.0",
      capabilities: {
        "support.inspect": defineCapability({
          description: "Returns a request-scoped principal snapshot.",
          input: z.object({
            value: z.string(),
            delayMs: z.number().optional(),
          }),
          output: z.object({ principalId: z.string(), tenant: z.string() }),
          access: "authenticated",
          async run({ input, context }) {
            if (input.value === "first") firstStarted();
            if (input.delayMs !== undefined) {
              await new Promise((resolve) =>
                setTimeout(resolve, input.delayMs),
              );
            }
            return {
              principalId: context.principal?.id ?? "anonymous",
              tenant: String(context.principal?.attributes?.tenant),
            };
          },
        }),
      },
    });
    const server = await start(engine, {
      auth: {
        mode: "required",
        authenticate(request) {
          const token =
            request.headers.get("authorization")?.slice(7) ?? "none";
          sharedPrincipal.id = `user:${token}`;
          sharedPrincipal.attributes.tenant = token;
          return sharedPrincipal;
        },
      },
    });

    const firstPending = callTool(server, {
      token: "alice",
      arguments: { value: "first", delayMs: 40 },
    });
    await didFirstStart;
    const second = await callTool(server, {
      token: "bob",
      arguments: { value: "second" },
    });
    sharedPrincipal.id = "user:mutated-after-authentication";
    sharedPrincipal.attributes.tenant = "mutated-after-authentication";
    const first = await firstPending;

    expect(await json(first)).toMatchObject({
      result: {
        structuredContent: { principalId: "user:alice", tenant: "alice" },
      },
    });
    expect(await json(second)).toMatchObject({
      result: {
        structuredContent: { principalId: "user:bob", tenant: "bob" },
      },
    });
  });

  it("passes a fresh principal to engine.invoke with the mcp-http source", async () => {
    const contexts: ExecutionContext[] = [];
    const server = await start(
      createContextEngine((context) => contexts.push(context)),
    );

    const response = await callTool(server, {
      token: "alice",
      arguments: { value: "hello" },
    });
    const payload = await json(response);

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      jsonrpc: "2.0",
      result: {
        structuredContent: {
          value: "hello",
          principalId: "user:alice",
        },
      },
    });
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toEqual(
      expect.objectContaining({
        source: "mcp-http",
        principal: { id: "user:alice" },
      }),
    );
  });

  it("interoperates with the official Streamable HTTP client", async () => {
    const server = await start();
    const transport = new StreamableHTTPClientTransport(
      new URL(endpoint(server)),
      { requestInit: { headers: { authorization: "Bearer official" } } },
    );
    const client = new Client(
      { name: "http-client-test", version: "0.0.0-test" },
      { capabilities: {} },
    );

    try {
      await client.connect(transport as unknown as Transport);
      await expect(
        client.callTool({
          name: "support.inspect",
          arguments: { value: "official-client" },
        }),
      ).resolves.toMatchObject({
        structuredContent: {
          value: "official-client",
          principalId: "user:official",
        },
      });
    } finally {
      await client.close();
    }
  });

  it("isolates principals across concurrent stateless requests", async () => {
    const server = await start();

    const [aliceResponse, bobResponse] = await Promise.all([
      callTool(server, {
        token: "alice",
        arguments: { value: "first", delayMs: 20 },
      }),
      callTool(server, {
        token: "bob",
        arguments: { value: "second" },
      }),
    ]);
    const [alice, bob] = await Promise.all([
      json(aliceResponse),
      json(bobResponse),
    ]);

    expect(alice).toMatchObject({
      result: { structuredContent: { principalId: "user:alice" } },
    });
    expect(bob).toMatchObject({
      result: { structuredContent: { principalId: "user:bob" } },
    });
    expect(aliceResponse.headers.get("mcp-session-id")).toBeNull();
    expect(bobResponse.headers.get("mcp-session-id")).toBeNull();
  });

  it("handles repeated JSON-RPC request IDs on fresh transports", async () => {
    const server = await start();

    const first = await callTool(server, {
      id: "reused-id",
      token: "alice",
      arguments: { value: "first" },
    });
    const second = await callTool(server, {
      id: "reused-id",
      token: "bob",
      arguments: { value: "second" },
    });

    expect(await json(first)).toMatchObject({
      id: "reused-id",
      result: { structuredContent: { principalId: "user:alice" } },
    });
    expect(await json(second)).toMatchObject({
      id: "reused-id",
      result: { structuredContent: { principalId: "user:bob" } },
    });
  });

  it("does not accept identity spoofing through capability input", async () => {
    const server = await start();

    const response = await callTool(server, {
      token: "trusted",
      arguments: {
        value: "inspect",
        principal: { id: "user:attacker" },
      },
    });

    expect(await json(response)).toMatchObject({
      result: { structuredContent: { principalId: "user:trusted" } },
    });
  });

  it("leaves authorization in the engine and denies before run", async () => {
    const run = vi.fn(async () => ({ ok: true }));
    const engine = createEngine({
      name: "forbidden-engine",
      version: "0.1.0",
      capabilities: {
        "support.inspect": defineCapability({
          description: "Requires the administrator principal.",
          input: z.object({ value: z.string() }),
          output: z.object({ ok: z.boolean() }),
          access: ({ principal }) => principal?.id === "user:administrator",
          run,
        }),
      },
    });
    const server = await start(engine);

    const response = await callTool(server, { token: "member" });
    const payload = await json(response);

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      result: {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              code: "FORBIDDEN",
              message: "Capability access is forbidden.",
            }),
          },
        ],
      },
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects hostile Host and Origin headers before authentication", async () => {
    const authenticate = vi.fn(async () => ({ id: "user:allowed" }));
    const server = await start(createContextEngine(), {
      auth: { mode: "required", authenticate },
    });

    const hostileHostStatus = await callToolWithRawHost(
      server,
      "attacker.example",
    );
    const hostileOrigin = await callTool(server, {
      token: "allowed",
      headers: { origin: "https://attacker.example" },
    });

    expect(hostileHostStatus).toBe(403);
    expect(hostileOrigin.status).toBe(403);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("rejects a missing Host header before authentication", async () => {
    const authenticate = vi.fn(async () => ({ id: "user:allowed" }));
    const server = await start(createContextEngine(), {
      auth: { mode: "required", authenticate },
    });
    const address = server.address();
    const status = await new Promise<number>((resolve, reject) => {
      const socket = createConnection(address.port, address.host);
      let response = "";
      socket.setEncoding("utf8");
      socket.once("connect", () => {
        socket.write("POST /mcp HTTP/1.0\r\nContent-Length: 0\r\n\r\n");
      });
      socket.on("data", (chunk) => {
        response += chunk;
      });
      socket.once("end", () => {
        resolve(Number(response.match(/^HTTP\/1\.1 (\d{3})/u)?.[1]));
      });
      socket.once("error", reject);
    });

    expect(status).toBe(403);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("rejects duplicate raw Host headers before authentication", async () => {
    const authenticate = vi.fn(async () => ({ id: "user:allowed" }));
    const server = await start(createContextEngine(), {
      auth: { mode: "required", authenticate },
    });
    const address = server.address();

    const status = await rawHttpStatus(
      server,
      [
        "POST /mcp HTTP/1.1",
        `Host: ${address.host}:${address.port}`,
        "Host: attacker.example",
        "Content-Length: 0",
        "",
        "",
      ].join("\r\n"),
    );

    expect(status).toBe(403);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("rejects duplicate raw Authorization headers before authentication", async () => {
    const authenticate = vi.fn(async () => ({ id: "user:allowed" }));
    const server = await start(createContextEngine(), {
      auth: { mode: "required", authenticate },
    });
    const address = server.address();

    const status = await rawHttpStatus(
      server,
      [
        "POST /mcp HTTP/1.1",
        `Host: ${address.host}:${address.port}`,
        "Authorization: Bearer allowed",
        "Authorization: Bearer attacker",
        "Accept: application/json, text/event-stream",
        "Content-Type: application/json",
        "Content-Length: 2",
        "",
        "{}",
      ].join("\r\n"),
    );

    expect(status).toBe(400);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("rejects an unbracketed IPv6 Host before authentication", async () => {
    const authenticate = vi.fn(async () => ({ id: "user:allowed" }));
    const server = await start(createContextEngine(), {
      auth: { mode: "required", authenticate },
    });

    const status = await rawHttpStatus(
      server,
      ["POST /mcp HTTP/1.1", "Host: ::1", "Content-Length: 0", "", ""].join(
        "\r\n",
      ),
    );

    expect(status).toBe(403);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("accepts an exact configured Origin after Host validation", async () => {
    const server = await start(createContextEngine(), {
      allowedOrigins: ["https://client.example.com"],
    });

    const response = await callTool(server, {
      token: "allowed",
      headers: { origin: "https://client.example.com" },
    });

    expect(response.status).toBe(200);
  });

  it("normalizes allowed Origin case and default ports", async () => {
    const server = await start(createContextEngine(), {
      allowedOrigins: ["HTTPS://CLIENT.EXAMPLE.COM:443"],
    });

    const response = await callTool(server, {
      token: "allowed",
      headers: { origin: "https://client.example.com" },
    });

    expect(response.status).toBe(200);
  });

  it.each([
    "null",
    "https://client.example.com/path",
    "https://client.example.com?query=true",
    "https://first.example, https://second.example",
    "https://user@client.example.com",
  ])("rejects malformed Origin %s before authentication", async (origin) => {
    const authenticate = vi.fn(async () => ({ id: "user:allowed" }));
    const server = await start(createContextEngine(), {
      allowedOrigins: ["https://client.example.com"],
      auth: { mode: "required", authenticate },
    });

    const response = await callTool(server, {
      token: "allowed",
      headers: { origin },
    });

    expect(response.status).toBe(403);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("requires explicit host allowlisting for a non-loopback bind", async () => {
    await expect(
      serveMcpHttp(createContextEngine(), {
        host: "0.0.0.0",
        port: 0,
        auth: { mode: "dangerously-disabled-for-development" },
      }),
    ).rejects.toThrow("allowedHosts");
  });

  it("serves only POST on /mcp and validates the protocol version header", async () => {
    const server = await start();

    const missing = await fetch(endpoint(server, "/other"));
    const get = await fetch(endpoint(server), {
      headers: { authorization: "Bearer alice" },
    });
    const deletion = await fetch(endpoint(server), {
      method: "DELETE",
      headers: { authorization: "Bearer alice" },
    });
    const unsupported = await callTool(server, {
      token: "alice",
      headers: { "mcp-protocol-version": "2099-01-01" },
    });

    expect(missing.status).toBe(404);
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    expect(deletion.status).toBe(405);
    expect(unsupported.status).toBe(400);
    expect(await json(unsupported)).toMatchObject({
      error: { code: -32000 },
    });
  });

  it("rejects an invalid MCP method before authentication", async () => {
    const authenticate = vi.fn(async () => ({ id: "user:allowed" }));
    const server = await start(createContextEngine(), {
      auth: { mode: "required", authenticate },
    });

    const response = await fetch(endpoint(server), {
      method: "PUT",
      headers: { authorization: "Bearer alice" },
      body: "ignored",
    });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("preserves Streamable HTTP media-type and notification responses", async () => {
    const server = await start();
    const unacceptable = await fetch(endpoint(server), {
      method: "POST",
      headers: {
        authorization: "Bearer alice",
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "accept-test",
        method: "tools/list",
      }),
    });
    const unsupported = await fetch(endpoint(server), {
      method: "POST",
      headers: {
        authorization: "Bearer alice",
        accept: "application/json, text/event-stream",
        "content-type": "text/plain",
      },
      body: "not-json",
    });
    const notification = await fetch(endpoint(server), {
      method: "POST",
      headers: {
        authorization: "Bearer alice",
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    });

    expect(unacceptable.status).toBe(406);
    expect(unsupported.status).toBe(415);
    expect(notification.status).toBe(202);
    expect(await notification.text()).toBe("");
  });

  it.each([
    "application/json;q=0, text/event-stream",
    "application/json, text/event-stream;q=0",
    "application/json-patch+json, text/event-stream",
    "text/application/json, text/event-stream",
  ])("rejects non-acceptable exact media ranges: %s", async (accept) => {
    const engine = createContextEngine();
    const invoke = vi.spyOn(engine, "invoke");
    const server = await start(engine);

    const response = await callTool(server, {
      token: "alice",
      headers: { accept },
    });

    expect(response.status).toBe(406);
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    "application/json-seq",
    "application/json-patch+json",
    'text/plain; note="application/json"',
  ])("rejects a non-exact JSON Content-Type: %s", async (contentType) => {
    const engine = createContextEngine();
    const invoke = vi.spyOn(engine, "invoke");
    const server = await start(engine);

    const response = await callTool(server, {
      token: "alice",
      headers: { "content-type": contentType },
    });

    expect(response.status).toBe(415);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("accepts exact media types case-insensitively with positive quality", async () => {
    const server = await start();

    const response = await callTool(server, {
      token: "alice",
      headers: {
        accept: "Application/JSON; q=1, Text/Event-Stream; q=0.5",
        "content-type": "Application/JSON; charset=utf-8",
      },
    });

    expect(response.status).toBe(200);
  });

  it.each([
    "[]",
    JSON.stringify([
      {
        jsonrpc: "2.0",
        id: "batch-call",
        method: "tools/call",
        params: {
          name: "support.inspect",
          arguments: { value: "must-not-run" },
        },
      },
    ]),
  ])("rejects every top-level JSON array before SDK dispatch", async (body) => {
    const engine = createContextEngine();
    const invoke = vi.spyOn(engine, "invoke");
    const server = await start(engine);

    const response = await fetch(endpoint(server), {
      method: "POST",
      headers: {
        authorization: "Bearer alice",
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body,
    });

    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({
      error: { code: -32600 },
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects a declared body larger than the configured limit", async () => {
    const engine = createContextEngine();
    const invoke = vi.spyOn(engine, "invoke");
    const authenticate = vi.fn(async () => ({ id: "user:allowed" }));
    const server = await start(engine, {
      maxRequestBodyBytes: 8,
      auth: { mode: "required", authenticate },
    });
    const address = server.address();

    const status = await rawHttpStatus(
      server,
      [
        "POST /mcp HTTP/1.1",
        `Host: ${address.host}:${address.port}`,
        "Authorization: Bearer alice",
        "Accept: application/json, text/event-stream",
        "Content-Type: application/json",
        "Content-Length: 9",
        "",
        "{}",
      ].join("\r\n"),
    );

    expect(status).toBe(413);
    expect(authenticate).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("settles body handling when the request was aborted during authentication", async () => {
    let authenticationStarted!: () => void;
    const didStartAuthentication = new Promise<void>((resolve) => {
      authenticationStarted = resolve;
    });
    const closeSpy = vi.spyOn(Server.prototype, "close");
    const server = await start(createContextEngine(), {
      auth: {
        mode: "required",
        async authenticate(request) {
          authenticationStarted();
          if (!request.signal.aborted) {
            await new Promise<void>((resolve) =>
              request.signal.addEventListener("abort", () => resolve(), {
                once: true,
              }),
            );
          }
          return { id: "user:disconnected" };
        },
      },
    });
    const address = server.address();
    const socket = createConnection(address.port, address.host);
    socket.once("connect", () => {
      socket.write(
        [
          "POST /mcp HTTP/1.1",
          `Host: ${address.host}:${address.port}`,
          "Authorization: Bearer alice",
          "Accept: application/json, text/event-stream",
          "Content-Type: application/json",
          "Content-Length: 100",
          "",
          "{",
        ].join("\r\n"),
      );
    });

    await didStartAuthentication;
    socket.destroy();

    try {
      await vi.waitFor(() => expect(closeSpy).toHaveBeenCalled(), {
        timeout: 1_000,
        interval: 10,
      });
    } finally {
      closeSpy.mockRestore();
    }
  });

  it.each([
    {
      name: "Host rejection",
      target: "/mcp",
      method: "POST",
      host: "attacker.example",
      authorization: "Bearer alice",
      accept: "application/json, text/event-stream",
      contentType: "application/json",
      expectedStatus: 403,
    },
    {
      name: "unknown path",
      target: "/other",
      method: "POST",
      authorization: "Bearer alice",
      accept: "application/json, text/event-stream",
      contentType: "application/json",
      expectedStatus: 404,
    },
    {
      name: "invalid method",
      target: "/mcp",
      method: "PUT",
      authorization: "Bearer alice",
      expectedStatus: 405,
    },
    {
      name: "missing authentication",
      target: "/mcp",
      method: "POST",
      accept: "application/json, text/event-stream",
      contentType: "application/json",
      expectedStatus: 401,
    },
    {
      name: "invalid media negotiation",
      target: "/mcp",
      method: "POST",
      authorization: "Bearer alice",
      accept: "application/json;q=0, text/event-stream",
      contentType: "application/json",
      expectedStatus: 406,
    },
  ])("closes a slow unconsumed body after $name", async (testCase) => {
    const server = await start();
    const address = server.address();
    const headers = [
      `${testCase.method} ${testCase.target} HTTP/1.1`,
      `Host: ${testCase.host ?? `${address.host}:${address.port}`}`,
      ...(testCase.authorization === undefined
        ? []
        : [`Authorization: ${testCase.authorization}`]),
      ...(testCase.accept === undefined ? [] : [`Accept: ${testCase.accept}`]),
      ...(testCase.contentType === undefined
        ? []
        : [`Content-Type: ${testCase.contentType}`]),
      "Content-Length: 100000",
      "",
      "",
    ].join("\r\n");

    const outcome = await rawHttpResponseFromSlowBody(server, headers);

    expect(outcome.response).toMatch(
      new RegExp(`^HTTP/1\\.1 ${testCase.expectedStatus}`, "u"),
    );
    expect(outcome.response.toLowerCase()).toContain("connection: close");
    expect(outcome.closed).toBe(true);
  });

  it("rejects a chunked body when reading crosses the configured limit", async () => {
    const engine = createContextEngine();
    const invoke = vi.spyOn(engine, "invoke");
    const server = await start(engine, { maxRequestBodyBytes: 8 });
    const address = server.address();

    const status = await rawHttpStatus(
      server,
      [
        "POST /mcp HTTP/1.1",
        `Host: ${address.host}:${address.port}`,
        "Authorization: Bearer alice",
        "Accept: application/json, text/event-stream",
        "Content-Type: application/json",
        "Transfer-Encoding: chunked",
        "",
        "5",
        "12345",
        "5",
        "67890",
        "0",
        "",
        "",
      ].join("\r\n"),
    );

    expect(status).toBe(413);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("uses a conservative one-megabyte body limit by default", async () => {
    const engine = createContextEngine();
    const invoke = vi.spyOn(engine, "invoke");
    const server = await start(engine);
    const address = server.address();

    const status = await rawHttpStatus(
      server,
      [
        "POST /mcp HTTP/1.1",
        `Host: ${address.host}:${address.port}`,
        "Authorization: Bearer alice",
        "Content-Length: 1048577",
        "",
        "",
      ].join("\r\n"),
    );

    expect(status).toBe(413);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("accepts a body exactly at the configured boundary", async () => {
    const server = await start(createContextEngine(), {
      maxRequestBodyBytes: 2,
    });
    const address = server.address();

    const status = await rawHttpStatus(
      server,
      [
        "POST /mcp HTTP/1.1",
        `Host: ${address.host}:${address.port}`,
        "Authorization: Bearer alice",
        "Accept: application/json, text/event-stream",
        "Content-Type: application/json",
        "Content-Length: 2",
        "",
        "{}",
      ].join("\r\n"),
    );

    expect(status).not.toBe(413);
  });

  it("rejects invalid request body limits before listening", async () => {
    await expect(
      serveMcpHttp(createContextEngine(), {
        port: 0,
        maxRequestBodyBytes: 0,
        auth: { mode: "dangerously-disabled-for-development" },
      }),
    ).rejects.toThrow("positive safe integer");
    await expect(
      serveMcpHttp(createContextEngine(), {
        port: 0,
        maxRequestBodyBytes: Number.POSITIVE_INFINITY,
        auth: { mode: "dangerously-disabled-for-development" },
      }),
    ).rejects.toThrow("positive safe integer");
  });

  it("rejects query and absolute-form request targets before authentication", async () => {
    const authenticate = vi.fn(async () => ({ id: "user:allowed" }));
    const server = await start(createContextEngine(), {
      auth: { mode: "required", authenticate },
    });

    const query = await callTool(server, {
      token: "allowed",
      headers: {},
    });
    const queryAddress = server.address();
    const queryStatus = await new Promise<number | undefined>(
      (resolve, reject) => {
        const request = httpRequest(
          {
            hostname: queryAddress.host,
            port: queryAddress.port,
            path: "/mcp?unsafe=true",
            method: "POST",
            headers: { host: `${queryAddress.host}:${queryAddress.port}` },
          },
          (response) => {
            response.resume();
            response.once("end", () => resolve(response.statusCode));
          },
        );
        request.once("error", reject);
        request.end();
      },
    );
    const absoluteStatus = await new Promise<number | undefined>(
      (resolve, reject) => {
        const request = httpRequest(
          {
            hostname: queryAddress.host,
            port: queryAddress.port,
            path: "http://attacker.example/mcp",
            method: "POST",
            headers: { host: `${queryAddress.host}:${queryAddress.port}` },
          },
          (response) => {
            response.resume();
            response.once("end", () => resolve(response.statusCode));
          },
        );
        request.once("error", reject);
        request.end();
      },
    );

    expect(query.status).toBe(200);
    expect(queryStatus).toBe(400);
    expect(absoluteStatus).toBe(400);
    expect(authenticate).toHaveBeenCalledTimes(1);
  });

  it.each(["/./mcp", "/routing/../mcp", "/%6dcp", "/m%63p"])(
    "rejects noncanonical MCP request target %s before authentication",
    async (target) => {
      const authenticate = vi.fn(async () => ({ id: "user:allowed" }));
      const engine = createContextEngine();
      const invoke = vi.spyOn(engine, "invoke");
      const server = await start(engine, {
        auth: { mode: "required", authenticate },
      });
      const address = server.address();

      const status = await rawHttpStatus(
        server,
        [
          `POST ${target} HTTP/1.1`,
          `Host: ${address.host}:${address.port}`,
          "Authorization: Bearer alice",
          "Accept: application/json, text/event-stream",
          "Content-Type: application/json",
          "Content-Length: 2",
          "",
          "{}",
        ].join("\r\n"),
      );

      expect(status).toBe(400);
      expect(authenticate).not.toHaveBeenCalled();
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it("publishes protected resource metadata and its 401 challenge", async () => {
    const resource = "https://engine.example.com/mcp";
    const server = await start(createContextEngine(), {
      auth: {
        mode: "required",
        async authenticate() {
          return null;
        },
        resourceMetadata: {
          resource,
          authorizationServers: ["https://auth.example.com"],
          scopesSupported: ["engine:invoke"],
        },
      },
    });

    const unauthorized = await callTool(server);
    const metadata = await fetch(
      endpoint(server, "/.well-known/oauth-protected-resource/mcp"),
    );

    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://engine.example.com/.well-known/oauth-protected-resource/mcp"',
    );
    expect(metadata.status).toBe(200);
    expect(await json(metadata)).toEqual({
      resource,
      authorization_servers: ["https://auth.example.com"],
      scopes_supported: ["engine:invoke"],
    });
  });

  it("rejects invalid protected resource metadata before listening", async () => {
    await expect(
      serveMcpHttp(createContextEngine(), {
        port: 0,
        auth: {
          mode: "required",
          async authenticate() {
            return null;
          },
          resourceMetadata: {
            resource: 'https://engine.example.com/mcp"unsafe',
            authorizationServers: ["https://auth.example.com"],
          },
        },
      }),
    ).rejects.toThrow("unsafe URL");

    await expect(
      serveMcpHttp(createContextEngine(), {
        port: 0,
        auth: {
          mode: "required",
          async authenticate() {
            return null;
          },
          resourceMetadata: {
            resource: "https://engine.example.com/mcp",
            authorizationServers: [] as unknown as readonly [
              string,
              ...string[],
            ],
          },
        },
      }),
    ).rejects.toThrow("at least one authorization server");
  });

  it("strictly validates protected resource and authorization server URLs", async () => {
    const invalidCases = [
      {
        resource: "http://engine.example.com/mcp",
        authorizationServers: ["https://auth.example.com"] as const,
      },
      {
        resource: "https://user@engine.example.com/mcp",
        authorizationServers: ["https://auth.example.com"] as const,
      },
      {
        resource: "https://engine.example.com/other",
        authorizationServers: ["https://auth.example.com"] as const,
      },
      {
        resource: "https://engine.example.com/mcp?query=true",
        authorizationServers: ["https://auth.example.com"] as const,
      },
      {
        resource: "https://engine.example.com/mcp#fragment",
        authorizationServers: ["https://auth.example.com"] as const,
      },
      {
        resource: "https://engine.example.com/mcp",
        authorizationServers: ["http://auth.example.com"] as const,
      },
      {
        resource: "https://engine.example.com/mcp",
        authorizationServers: ["https://user@auth.example.com"] as const,
      },
      {
        resource: "https://engine.example.com/mcp",
        authorizationServers: ["https://auth.example.com?query=true"] as const,
      },
      {
        resource: "https://engine.example.com/mcp",
        authorizationServers: ["https://auth.example.com#fragment"] as const,
      },
    ];

    for (const resourceMetadata of invalidCases) {
      let error: unknown;
      try {
        const server = await serveMcpHttp(createContextEngine(), {
          port: 0,
          auth: {
            mode: "required",
            authenticate: () => null,
            resourceMetadata,
          },
        });
        openServers.push(server);
      } catch (cause) {
        error = cause;
      }
      expect(error).toBeInstanceOf(TypeError);
    }
  });

  it("allows loopback HTTP resources and authorization-server issuer paths", async () => {
    const server = await start(createContextEngine(), {
      auth: {
        mode: "required",
        authenticate: () => null,
        resourceMetadata: {
          resource: "http://127.0.0.1:3000/mcp",
          authorizationServers: ["https://auth.example.com/tenant"],
        },
      },
    });

    expect(server.address()).toEqual({
      host: "127.0.0.1",
      port: expect.any(Number),
    });
  });

  it("propagates a disconnected HTTP request to the capability signal", async () => {
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    let cancelled!: () => void;
    const didCancel = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    const engine = createEngine({
      name: "http-cancellation-engine",
      version: "0.1.0",
      capabilities: {
        "support.inspect": defineCapability({
          description: "Waits for an HTTP request to disconnect.",
          input: z.object({ value: z.string() }),
          output: z.object({ done: z.boolean() }),
          access: "authenticated",
          async run({ context }) {
            started();
            context.signal.addEventListener("abort", () => cancelled(), {
              once: true,
            });
            return await new Promise(() => undefined);
          },
        }),
      },
    });
    const server = await start(engine);
    const controller = new AbortController();
    const pending = fetch(endpoint(server), {
      method: "POST",
      headers: {
        authorization: "Bearer alice",
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "cancel-http",
        method: "tools/call",
        params: { name: "support.inspect", arguments: { value: "wait" } },
      }),
      signal: controller.signal,
    });

    await didStart;
    controller.abort();

    await expect(pending).rejects.toThrow();
    await expect(didCancel).resolves.toBeUndefined();
  });

  it("requires an explicit dangerous opt-out when authentication is disabled", async () => {
    const engine = createEngine({
      name: "public-engine",
      version: "0.1.0",
      capabilities: {
        "support.inspect": defineCapability({
          description: "Returns a public value in development.",
          input: z.object({ value: z.string() }),
          output: z.object({ value: z.string() }),
          access: "public",
          async run({ input }) {
            return input;
          },
        }),
      },
    });
    const server = await serveMcpHttp(engine, {
      port: 0,
      auth: { mode: "dangerously-disabled-for-development" },
    });
    openServers.push(server);

    const response = await callTool(server, { arguments: { value: "public" } });

    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
      result: { structuredContent: { value: "public" } },
    });
  });

  it("closes the neutral server handle idempotently", async () => {
    const server = await start();

    await server.close();
    await expect(server.close()).resolves.toBeUndefined();
  });

  it("concurrent close aborts active requests and cannot hang", async () => {
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    let cancelled!: () => void;
    const didCancel = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    const engine = createEngine({
      name: "shutdown-engine",
      version: "0.1.0",
      capabilities: {
        "support.inspect": defineCapability({
          description: "Waits for server shutdown.",
          input: z.object({ value: z.string() }),
          output: z.object({ done: z.boolean() }),
          access: "authenticated",
          async run({ context }) {
            started();
            context.signal.addEventListener("abort", () => cancelled(), {
              once: true,
            });
            return await new Promise(() => undefined);
          },
        }),
      },
    });
    const server = await start(engine);
    const controller = new AbortController();
    const pending = callTool(server, {
      token: "alice",
      signal: controller.signal,
    });
    const pendingRejection = expect(pending).rejects.toThrow();
    await didStart;

    const closing = Promise.all([server.close(), server.close()]);
    const outcome = await Promise.race([
      closing.then(() => "closed" as const),
      new Promise<"timed-out">((resolve) =>
        setTimeout(() => resolve("timed-out"), 100),
      ),
    ]);

    if (outcome === "timed-out") {
      controller.abort();
      await closing;
    }

    expect(outcome).toBe("closed");
    await expect(didCancel).resolves.toBeUndefined();
    await pendingRejection;
  });
});
