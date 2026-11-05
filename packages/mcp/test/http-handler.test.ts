import {
  CapabilityError,
  createEngine,
  defineCapability,
  type ExecutionContext,
} from "@invokta/core";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import * as root from "../src/index.js";
import {
  createMcpHttpHandler,
  type McpHttpAuthenticationRequest,
  type McpHttpHandlerOptions,
  McpToolNameCollisionError,
} from "../src/web.js";

const ORIGIN = "http://127.0.0.1:3000";
const PROTOCOL_HEADERS = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
} as const;

function createContextEngine(
  observeContext: (context: ExecutionContext) => void = () => undefined,
) {
  return createEngine({
    name: "web-handler-engine",
    version: "0.1.0",
    capabilities: {
      "support.inspect": defineCapability({
        description: "Returns the authenticated HTTP execution context.",
        input: z.object({ value: z.string() }),
        output: z.object({
          value: z.string(),
          principalId: z.string(),
          source: z.string(),
        }),
        access: "authenticated",
        async run({ input, context }) {
          observeContext(context);
          return {
            value: input.value,
            principalId: context.principal?.id ?? "anonymous",
            source: context.source,
          };
        },
      }),
      "support.fail": defineCapability({
        description: "Fails with a private cause.",
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        access: "authenticated",
        async run() {
          throw new Error("private failure detail");
        },
      }),
      "support.admin": defineCapability({
        description: "Requires the administrator principal.",
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        access: ({ principal }) => principal?.id === "user:administrator",
        async run() {
          return { ok: true };
        },
      }),
    },
  });
}

async function bearer(
  request: McpHttpAuthenticationRequest,
): Promise<{ id: string } | null> {
  const authorization = request.headers.get("authorization");
  if (authorization === null || !authorization.startsWith("Bearer ")) {
    return null;
  }
  const token = authorization.slice("Bearer ".length);
  return token === "invalid" ? null : { id: `user:${token}` };
}

function handlerFor(
  engine = createContextEngine(),
  overrides: Partial<McpHttpHandlerOptions> = {},
) {
  return createMcpHttpHandler(engine, {
    auth: { mode: "required", authenticate: bearer },
    ...overrides,
  });
}

function toolCall(
  name: string,
  args: Readonly<Record<string, unknown>> = {},
  id: string | number = crypto.randomUUID(),
) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  };
}

function post(
  body: unknown,
  options: {
    readonly url?: string;
    readonly token?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal;
  } = {},
): Request {
  return new Request(options.url ?? `${ORIGIN}/mcp`, {
    method: "POST",
    headers: {
      ...PROTOCOL_HEADERS,
      ...(options.token === undefined
        ? {}
        : { authorization: `Bearer ${options.token}` }),
      ...options.headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("Web-standard MCP HTTP handler", () => {
  it("is published by the portable entry and the package root", () => {
    expect(root.createMcpHttpHandler).toBe(createMcpHttpHandler);
    expect(root.McpToolNameCollisionError).toBe(McpToolNameCollisionError);
  });

  it("lists and calls tools through engine.invoke with the mcp-http source", async () => {
    const contexts: ExecutionContext[] = [];
    const engine = createContextEngine((context) => contexts.push(context));
    const invoke = vi.spyOn(engine, "invoke");
    const handler = handlerFor(engine);

    const listed = await handler(
      post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { token: "alice" }),
    );
    const called = await handler(
      post(toolCall("support_inspect", { value: "hello" }, 2), {
        token: "alice",
      }),
    );

    expect(listed.status).toBe(200);
    expect(await json(listed)).toMatchObject({
      id: 1,
      result: {
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "support_inspect" }),
        ]),
      },
    });
    expect(called.status).toBe(200);
    expect(called.headers.get("mcp-session-id")).toBeNull();
    expect(await json(called)).toMatchObject({
      jsonrpc: "2.0",
      id: 2,
      result: {
        structuredContent: {
          value: "hello",
          principalId: "user:alice",
          source: "mcp-http",
        },
      },
    });
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0]?.[0]).toBe("support.inspect");
    expect(contexts[0]).toEqual(
      expect.objectContaining({
        source: "mcp-http",
        principal: { id: "user:alice" },
      }),
    );
  });

  it("returns sanitized capability failures and denials as tool errors", async () => {
    const handler = handlerFor();

    const failed = await handler(
      post(toolCall("support_fail"), { token: "alice" }),
    );
    const denied = await handler(
      post(toolCall("support_admin"), { token: "member" }),
    );
    const failure = await json(failed);

    expect(failed.status).toBe(200);
    expect(failure).toMatchObject({
      result: {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              code: "EXECUTION_FAILED",
              message: "Capability execution failed.",
            }),
          },
        ],
      },
    });
    expect(JSON.stringify(failure)).not.toContain("private failure detail");
    expect(denied.status).toBe(200);
    expect(await json(denied)).toMatchObject({
      result: {
        isError: true,
        content: [{ text: expect.stringContaining('"code":"FORBIDDEN"') }],
      },
    });
  });

  it("returns a declared domain error as a structured tool error", async () => {
    const engine = createEngine({
      name: "web-domain-error-engine",
      version: "0.1.0",
      capabilities: {
        "appointments.schedule": defineCapability({
          description: "Schedule an appointment in a free slot.",
          input: z.object({ slotId: z.string() }),
          output: z.object({ confirmed: z.boolean() }),
          access: "authenticated",
          errors: {
            SLOT_CONFLICT: {
              description: "The requested slot is no longer available.",
              details: z.object({ slotId: z.string() }),
              retryable: false,
            },
          },
          async run({ input }) {
            throw new CapabilityError("SLOT_CONFLICT", {
              details: { slotId: input.slotId },
              cause: new Error("secret calendar token: top-secret"),
            });
          },
        }),
      },
    });

    const handler = createMcpHttpHandler(engine, {
      auth: { mode: "required", authenticate: bearer },
    });

    const response = await handler(
      post(toolCall("appointments_schedule", { slotId: "S-1" }), {
        token: "alice",
      }),
    );
    const payload = await json(response);

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      result: {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              code: "DOMAIN_ERROR",
              message: "The requested slot is no longer available.",
              publicDetails: {
                code: "SLOT_CONFLICT",
                retryable: false,
                details: { slotId: "S-1" },
              },
            }),
          },
        ],
      },
    });
    expect(JSON.stringify(payload)).not.toContain("top-secret");
  });

  it("answers an unknown tool with a protocol error", async () => {
    const response = await handlerFor()(
      post(toolCall("support_missing"), { token: "alice" }),
    );

    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
      error: { code: -32602 },
    });
  });

  it("authenticates before invoke and challenges missing credentials", async () => {
    const engine = createContextEngine();
    const invoke = vi.spyOn(engine, "invoke");
    const authenticate = vi.fn(bearer);
    const handler = handlerFor(engine, {
      auth: { mode: "required", authenticate },
    });

    const missing = await handler(post(toolCall("support_inspect")));
    const invalid = await handler(
      post(toolCall("support_inspect"), { token: "invalid" }),
    );

    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe("Bearer");
    expect(await json(missing)).toEqual({ error: "unauthorized" });
    expect(invalid.status).toBe(401);
    expect(invoke).not.toHaveBeenCalled();
    const request = authenticate.mock.calls[0]?.[0];
    expect(request?.path).toBe("/mcp");
    expect(request?.method).toBe("POST");
    expect(request?.headers.has("accept")).toBe(true);
    expect(request?.signal).toBeInstanceOf(AbortSignal);
    expect(Object.keys(request?.headers ?? {}).sort()).toEqual(["get", "has"]);
  });

  it("sanitizes authenticator failures and rejects malformed principals", async () => {
    const engine = createContextEngine();
    const invoke = vi.spyOn(engine, "invoke");
    const failing = handlerFor(engine, {
      auth: {
        mode: "required",
        authenticate() {
          throw new Error("identity provider secret: top-secret");
        },
      },
    });
    const malformed = handlerFor(engine, {
      auth: {
        mode: "required",
        authenticate: () => ({ id: "user:x", attributes: [] }) as never,
      },
    });

    const failure = await failing(
      post(toolCall("support_inspect"), { token: "alice" }),
    );
    const rejected = await malformed(
      post(toolCall("support_inspect"), { token: "alice" }),
    );
    const payload = await json(failure);

    expect(failure.status).toBe(500);
    expect(payload).toEqual({ error: "authentication_failed" });
    expect(JSON.stringify(payload)).not.toContain("top-secret");
    expect(rejected.status).toBe(401);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("accepts loopback hosts by default and validates the Host header and URL authority", async () => {
    const authenticate = vi.fn(bearer);
    const handler = handlerFor(createContextEngine(), {
      auth: { mode: "required", authenticate },
    });
    const call = (url: string, headers: Record<string, string> = {}) =>
      handler(
        post(toolCall("support_inspect", { value: "host" }), {
          url,
          token: "alice",
          headers,
        }),
      );

    const loopback = await Promise.all([
      call("http://127.0.0.1:3000/mcp"),
      call("http://localhost/mcp"),
      call("http://[::1]:8787/mcp"),
      call("http://127.0.0.1:3000/mcp", { host: "localhost:3000" }),
    ]);
    const callsBeforeRejections = authenticate.mock.calls.length;
    const rejected = await Promise.all([
      call("http://127.0.0.1:3000/mcp", { host: "attacker.example" }),
      call("http://attacker.example/mcp"),
      call("http://attacker.example/mcp", { host: "127.0.0.1:3000" }),
      call("http://127.0.0.1:3000/mcp", {
        host: "127.0.0.1:3000, attacker.example",
      }),
      call("http://127.0.0.1:3000/mcp", { host: "::1" }),
    ]);

    expect(loopback.map(({ status }) => status)).toEqual([200, 200, 200, 200]);
    expect(rejected.map(({ status }) => status)).toEqual([
      403, 403, 403, 403, 403,
    ]);
    expect(await json(rejected[0] as Response)).toEqual({ error: "forbidden" });
    expect(authenticate).toHaveBeenCalledTimes(callsBeforeRejections);
  });

  it("uses an explicit host allowlist instead of the loopback default", async () => {
    const handler = handlerFor(createContextEngine(), {
      allowedHosts: ["engine.example.com"],
    });

    const allowed = await handler(
      post(toolCall("support_inspect", { value: "public" }), {
        url: "https://engine.example.com/mcp",
        token: "alice",
      }),
    );
    const loopback = await handler(
      post(toolCall("support_inspect", { value: "local" }), { token: "alice" }),
    );

    expect(allowed.status).toBe(200);
    expect(loopback.status).toBe(403);
    expect(() =>
      handlerFor(createContextEngine(), { allowedHosts: [] }),
    ).toThrow("allowedHosts must contain at least one host.");
  });

  it("validates any supplied Origin against the explicit allowlist", async () => {
    const authenticate = vi.fn(bearer);
    const handler = handlerFor(createContextEngine(), {
      allowedOrigins: ["HTTPS://CONSOLE.EXAMPLE.COM:443"],
      auth: { mode: "required", authenticate },
    });
    const call = (origin: string) =>
      handler(
        post(toolCall("support_inspect", { value: "origin" }), {
          token: "alice",
          headers: { origin },
        }),
      );

    const allowed = await call("https://console.example.com");
    const rejected = await Promise.all([
      call("https://attacker.example"),
      call("null"),
      call("https://console.example.com/path"),
      call("https://console.example.com, https://attacker.example"),
    ]);
    const withoutAllowlist = await handlerFor()(
      post(toolCall("support_inspect", { value: "origin" }), {
        token: "alice",
        headers: { origin: "https://console.example.com" },
      }),
    );

    expect(allowed.status).toBe(200);
    expect(rejected.map(({ status }) => status)).toEqual([403, 403, 403, 403]);
    expect(withoutAllowlist.status).toBe(403);
    expect(authenticate).toHaveBeenCalledOnce();
  });

  it("routes only the exact canonical mount path before authentication", async () => {
    const authenticate = vi.fn(bearer);
    const handler = handlerFor(createContextEngine(), {
      auth: { mode: "required", authenticate },
    });
    const statusFor = async (url: string) =>
      (
        await handler(
          post(toolCall("support_inspect", { value: "x" }), {
            url,
            token: "alice",
          }),
        )
      ).status;

    expect(await statusFor(`${ORIGIN}/other`)).toBe(404);
    expect(await statusFor(`${ORIGIN}/mcp/`)).toBe(404);
    expect(await statusFor(`${ORIGIN}/mcp?unsafe=true`)).toBe(400);
    expect(await statusFor(`${ORIGIN}/mcp?`)).toBe(400);
    expect(await statusFor(`${ORIGIN}/mcp#fragment`)).toBe(400);
    expect(await statusFor(`${ORIGIN}/m%63p`)).toBe(400);
    expect(await statusFor(`${ORIGIN}/%6dcp`)).toBe(400);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("serves a configured mount path and its path-suffix metadata", async () => {
    const handler = handlerFor(createContextEngine(), {
      path: "/e/orders/mcp",
      allowedHosts: ["gateway.example.com"],
      auth: {
        mode: "required",
        authenticate: bearer,
        resourceMetadata: {
          resource: "https://gateway.example.com/e/orders/mcp",
          authorizationServers: ["https://auth.example.com"],
        },
      },
    });

    const mounted = await handler(
      post(toolCall("support_inspect", { value: "mounted" }), {
        url: "https://gateway.example.com/e/orders/mcp",
        token: "alice",
      }),
    );
    const defaultPath = await handler(
      post(toolCall("support_inspect", { value: "x" }), {
        url: "https://gateway.example.com/mcp",
        token: "alice",
      }),
    );
    const metadata = await handler(
      new Request(
        "https://gateway.example.com/.well-known/oauth-protected-resource/e/orders/mcp",
      ),
    );

    expect(mounted.status).toBe(200);
    expect(defaultPath.status).toBe(404);
    expect(metadata.status).toBe(200);
    expect(await json(metadata)).toEqual({
      resource: "https://gateway.example.com/e/orders/mcp",
      authorization_servers: ["https://auth.example.com"],
    });
  });

  it("rejects unsupported methods before authentication", async () => {
    const authenticate = vi.fn(bearer);
    const handler = handlerFor(createContextEngine(), {
      auth: { mode: "required", authenticate },
    });

    const get = await handler(
      new Request(`${ORIGIN}/mcp`, {
        headers: { authorization: "Bearer alice" },
      }),
    );
    const put = await handler(
      new Request(`${ORIGIN}/mcp`, {
        method: "PUT",
        headers: { authorization: "Bearer alice" },
        body: "ignored",
      }),
    );

    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    expect(put.status).toBe(405);
    expect(await json(put)).toEqual({ error: "method_not_allowed" });
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("rejects a declared body larger than the limit before authentication", async () => {
    const authenticate = vi.fn(bearer);
    const handler = handlerFor(createContextEngine(), {
      maxRequestBodyBytes: 8,
      auth: { mode: "required", authenticate },
    });

    const response = await handler(
      post("{}", { token: "alice", headers: { "content-length": "9" } }),
    );

    expect(response.status).toBe(413);
    expect(await json(response)).toEqual({ error: "payload_too_large" });
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("stops reading and cancels a streamed body that crosses the limit", async () => {
    const engine = createContextEngine();
    const invoke = vi.spyOn(engine, "invoke");
    const handler = handlerFor(engine, { maxRequestBodyBytes: 4096 });
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(1024).fill(0x20));
      },
      cancel() {
        cancelled = true;
      },
    });

    const response = await handler(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { ...PROTOCOL_HEADERS, authorization: "Bearer alice" },
        body,
        duplex: "half",
      } as RequestInit),
    );

    expect(response.status).toBe(413);
    expect(pulls).toBeLessThanOrEqual(7);
    await vi.waitFor(() => expect(cancelled).toBe(true));
    expect(invoke).not.toHaveBeenCalled();
  });

  it("settles and cancels a stalled body when the request signal aborts", async () => {
    const engine = createContextEngine();
    const invoke = vi.spyOn(engine, "invoke");
    const handler = handlerFor(engine);
    let cancelled = false;
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0",'));
      },
      cancel() {
        cancelled = true;
      },
    });

    const response = await handler(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { ...PROTOCOL_HEADERS, authorization: "Bearer alice" },
        body: stalled,
        duplex: "half",
        signal: AbortSignal.timeout(50),
      } as RequestInit),
    );

    expect(response.status).toBe(500);
    expect(await json(response)).toEqual({
      jsonrpc: "2.0",
      error: { code: -32603, message: "Internal server error" },
      id: null,
    });
    expect(cancelled).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not read the body of an already aborted request", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(new TextEncoder().encode("{}"));
        },
      },
      { highWaterMark: 0 },
    );
    const controller = new AbortController();
    const handler = handlerFor(createContextEngine(), {
      auth: {
        mode: "required",
        authenticate: () => {
          controller.abort();
          return { id: "user:alice" };
        },
      },
    });

    const response = await handler(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: PROTOCOL_HEADERS,
        body,
        duplex: "half",
        signal: controller.signal,
      } as RequestInit),
    );

    expect(response.status).toBe(500);
    expect(pulls).toBe(0);
  });

  it("accepts a body exactly at the configured boundary", async () => {
    const body = JSON.stringify(toolCall("support_inspect", { value: "x" }));
    const handler = handlerFor(createContextEngine(), {
      maxRequestBodyBytes: new TextEncoder().encode(body).byteLength,
    });

    const response = await handler(post(body, { token: "alice" }));

    expect(response.status).toBe(200);
  });

  it("rejects malformed UTF-8 before SDK dispatch", async () => {
    const engine = createContextEngine();
    const invoke = vi.spyOn(engine, "invoke");
    const connect = vi.spyOn(Server.prototype, "connect");
    const handler = handlerFor(engine);
    const prefix = new TextEncoder().encode(
      '{"jsonrpc":"2.0","id":"utf8","method":"tools/call","params":{"name":"support_inspect","arguments":{"value":"',
    );

    try {
      const response = await handler(
        new Request(`${ORIGIN}/mcp`, {
          method: "POST",
          headers: { ...PROTOCOL_HEADERS, authorization: "Bearer alice" },
          body: new Uint8Array([...prefix, 0xc3]),
        }),
      );

      expect(response.status).toBe(400);
      expect(await json(response)).toEqual({
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error: Invalid UTF-8" },
        id: null,
      });
      expect(connect).not.toHaveBeenCalled();
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      connect.mockRestore();
    }
  });

  it("rejects invalid JSON and every top-level batch", async () => {
    const engine = createContextEngine();
    const invoke = vi.spyOn(engine, "invoke");
    const handler = handlerFor(engine);

    const invalid = await handler(post("{", { token: "alice" }));
    const batch = await handler(
      post([toolCall("support_inspect", { value: "must-not-run" })], {
        token: "alice",
      }),
    );

    expect(invalid.status).toBe(400);
    expect(await json(invalid)).toMatchObject({ error: { code: -32700 } });
    expect(batch.status).toBe(400);
    expect(await json(batch)).toMatchObject({ error: { code: -32600 } });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("enforces media types after authentication", async () => {
    const engine = createContextEngine();
    const invoke = vi.spyOn(engine, "invoke");
    const handler = handlerFor(engine);
    const call = (headers: Record<string, string>) =>
      handler(
        post(toolCall("support_inspect", { value: "media" }), {
          token: "alice",
          headers,
        }),
      );

    const unacceptable = await call({ accept: "application/json" });
    const unsupported = await call({ "content-type": "text/plain" });
    const merged = await call({
      "content-type": "application/json; charset=utf-8, text/plain",
    });
    const unauthenticated = await handler(
      post(toolCall("support_inspect"), {
        headers: { "content-type": "text/plain" },
      }),
    );
    const accepted = await call({
      accept: "Application/JSON; q=1, Text/Event-Stream; q=0.5",
      "content-type": "Application/JSON; charset=utf-8",
    });

    expect(unacceptable.status).toBe(406);
    expect(unsupported.status).toBe(415);
    expect(merged.status).toBe(415);
    expect(unauthenticated.status).toBe(401);
    expect(accepted.status).toBe(200);
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("treats only a comma outside a quoted string as a repeated Content-Type", async () => {
    const handler = handlerFor();
    const call = (contentType: string) =>
      handler(
        post(toolCall("support_inspect", { value: "quoted" }), {
          token: "alice",
          headers: { "content-type": contentType },
        }),
      );

    const quoted = await call('application/json; profile="a,b"');
    const escaped = await call('application/json; profile="a\\",b"');
    const repeatedAfterQuote = await call(
      'application/json; profile="a,b", text/plain',
    );
    const unterminated = await call('application/json; profile="a, text/plain');

    expect(quoted.status).toBe(200);
    expect(escaped.status).toBe(200);
    expect(repeatedAfterQuote.status).toBe(415);
    expect(unterminated.status).toBe(415);
  });

  it("accepts a notification without a protocol result body", async () => {
    const response = await handlerFor()(
      post(
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { token: "alice" },
      ),
    );

    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  it("round trips falsy request IDs on fresh stateless transports", async () => {
    const handler = handlerFor();

    const [numeric, empty, reused] = await Promise.all([
      handler(
        post(toolCall("support_inspect", { value: "a" }, 0), { token: "a" }),
      ),
      handler(
        post(toolCall("support_inspect", { value: "b" }, ""), { token: "b" }),
      ),
      handler(
        post(toolCall("support_inspect", { value: "c" }, 0), { token: "c" }),
      ),
    ]);

    expect(await json(numeric)).toMatchObject({
      id: 0,
      result: { structuredContent: { principalId: "user:a" } },
    });
    expect(await json(empty)).toMatchObject({
      id: "",
      result: { structuredContent: { principalId: "user:b" } },
    });
    expect(await json(reused)).toMatchObject({
      id: 0,
      result: { structuredContent: { principalId: "user:c" } },
    });
  });

  it("publishes protected resource metadata and its challenge", async () => {
    const resource = "https://engine.example.com/mcp";
    const handler = handlerFor(createContextEngine(), {
      allowedHosts: ["engine.example.com"],
      auth: {
        mode: "required",
        authenticate: () => null,
        challengeScopes: ["engine:invoke"],
        resourceMetadata: {
          resource,
          authorizationServers: ["https://auth.example.com"],
          scopesSupported: ["engine:invoke"],
        },
      },
    });
    const metadataUrl = getOAuthProtectedResourceMetadataUrl(new URL(resource));

    const unauthorized = await handler(
      post(toolCall("support_inspect"), { url: resource }),
    );
    const metadata = await handler(new Request(metadataUrl));
    const wrongMethod = await handler(
      new Request(metadataUrl, { method: "POST", body: "{}" }),
    );

    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${metadataUrl}", scope="engine:invoke"`,
    );
    expect(metadata.status).toBe(200);
    expect(metadata.headers.get("content-type")).toBe("application/json");
    expect(await json(metadata)).toEqual({
      resource,
      authorization_servers: ["https://auth.example.com"],
      scopes_supported: ["engine:invoke"],
    });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("GET");
  });

  it("propagates request cancellation to the capability signal", async () => {
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    let cancelled!: () => void;
    const didCancel = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    const engine = createEngine({
      name: "web-cancellation-engine",
      version: "0.1.0",
      capabilities: {
        "support.wait": defineCapability({
          description: "Waits for the request to be cancelled.",
          input: z.object({}),
          output: z.object({ done: z.boolean() }),
          access: "public",
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
    const handler = createMcpHttpHandler(engine, {
      auth: { mode: "dangerously-disabled-for-development" },
    });
    const controller = new AbortController();

    const pending = handler(
      post(toolCall("support_wait"), { signal: controller.signal }),
    );
    await didStart;
    controller.abort();

    await expect(didCancel).resolves.toBeUndefined();
    await expect(pending).resolves.toBeInstanceOf(Response);
  });

  it("serves public capabilities in the explicit development mode", async () => {
    const engine = createEngine({
      name: "public-web-engine",
      version: "0.1.0",
      capabilities: {
        "support.echo": defineCapability({
          description: "Echoes a public value.",
          input: z.object({ value: z.string() }),
          output: z.object({ value: z.string() }),
          access: "public",
          async run({ input }) {
            return input;
          },
        }),
      },
    });
    const handler = createMcpHttpHandler(engine, {
      auth: { mode: "dangerously-disabled-for-development" },
    });

    const response = await handler(
      post(toolCall("support_echo", { value: "public" })),
    );

    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
      result: { structuredContent: { value: "public" } },
    });
  });

  it("resolves with a sanitized failure for a request object it cannot read", async () => {
    const hostile = new Proxy(post(toolCall("support_inspect")), {
      get() {
        throw new Error("hostile request secret");
      },
    });

    const response = await handlerFor()(hostile);
    const payload = await json(response);

    expect(response.status).toBe(500);
    expect(payload).toEqual({ error: "internal_error" });
  });

  it("validates its configuration synchronously at creation", () => {
    const engine = createContextEngine();
    const capability = defineCapability({
      description: "Creates a tool-name collision fixture.",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      access: "public",
      async run() {
        return { ok: true };
      },
    });
    const colliding = createEngine({
      name: "colliding-web-engine",
      version: "0.1.0",
      capabilities: { "support.echo": capability, support_echo: capability },
    });
    const auth = { mode: "required", authenticate: bearer } as const;

    expect(() =>
      createMcpHttpHandler(engine, { auth, maxRequestBodyBytes: 0 }),
    ).toThrow("maxRequestBodyBytes must be a positive safe integer.");
    expect(() => createMcpHttpHandler(engine, { auth, path: "/mcp/" })).toThrow(
      TypeError,
    );
    expect(() =>
      createMcpHttpHandler(engine, { auth: { mode: "unexpected" } as never }),
    ).toThrow("auth.mode");
    expect(() =>
      createMcpHttpHandler(engine, {
        auth: { ...auth, challengeScopes: ["engine:invoke"] },
      }),
    ).toThrow("requires auth.resourceMetadata");
    expect(() =>
      createMcpHttpHandler(engine, {
        auth: {
          ...auth,
          resourceMetadata: {
            resource: "https://engine.example.com/other",
            authorizationServers: ["https://auth.example.com"],
          },
        },
      }),
    ).toThrow(TypeError);
    expect(() => createMcpHttpHandler(colliding, { auth })).toThrow(
      McpToolNameCollisionError,
    );
  });

  it("snapshots the authentication hook at creation", async () => {
    const original = vi.fn(() => ({ id: "user:original" }));
    const replacement = vi.fn(() => ({ id: "user:replacement" }));
    const auth = { mode: "required", authenticate: original } as {
      mode: string;
      authenticate: typeof original;
    };
    const handler = handlerFor(createContextEngine(), { auth: auth as never });

    auth.mode = "dangerously-disabled-for-development";
    auth.authenticate = replacement;
    const response = await handler(
      post(toolCall("support_inspect", { value: "x" }), { token: "alice" }),
    );

    expect(await json(response)).toMatchObject({
      result: { structuredContent: { principalId: "user:original" } },
    });
    expect(replacement).not.toHaveBeenCalled();
  });
});
