import {
  CapabilityError,
  createEngine,
  defineCapability,
  type Engine,
  EngineError,
  type EngineEvent,
  type ExecutionContext,
  type Principal,
} from "@invokta/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createHttpHandler,
  createHttpOpenApiDocument,
  type HttpAuthenticationRequest,
  type HttpAuthOptions,
  type HttpCorsOptions,
  type HttpHandlerOptions,
} from "../src/index.js";

const origin = "http://localhost:3000";
const disabledAuth = {
  mode: "dangerously-disabled-for-development",
} as const satisfies HttpAuthOptions;

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

function createTestEngine(
  options: {
    readonly observe?: (context: ExecutionContext) => void;
    readonly onEvent?: (event: EngineEvent) => void;
  } = {},
) {
  return createEngine({
    name: "http-test-engine",
    version: "1.2.3",
    ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
    capabilities: {
      "support.echo": defineCapability({
        title: "Echo",
        description: "Returns the value with the execution identity.",
        input: z.object({ value: z.string() }),
        output: z.object({
          value: z.string(),
          principalId: z.string(),
          source: z.string(),
        }),
        access: "public",
        annotations: { readOnly: true },
        async run({ input, context }) {
          options.observe?.(context);
          return {
            value: input.value,
            principalId: context.principal?.id ?? "anonymous",
            source: context.source,
          };
        },
      }),
      "support.private": defineCapability({
        description: "Requires an authenticated principal.",
        input: z.object({}),
        output: z.object({ principalId: z.string() }),
        access: "authenticated",
        async run({ context }) {
          return { principalId: context.principal?.id ?? "anonymous" };
        },
      }),
      "support.denied": defineCapability({
        description: "Denies every caller.",
        input: z.object({}),
        output: z.object({}),
        access: () => false,
        async run() {
          return {};
        },
      }),
      "support.wait": defineCapability({
        description: "Waits until the invocation is cancelled.",
        input: z.object({}),
        output: z.object({}),
        access: "public",
        async run({ context }) {
          options.observe?.(context);
          return waitForAbort(context.signal);
        },
      }),
      "support.slow": defineCapability({
        description: "Exceeds its timeout.",
        input: z.object({}),
        output: z.object({}),
        access: "public",
        timeoutMs: 10,
        async run({ context }) {
          return waitForAbort(context.signal);
        },
      }),
      "support.broken": defineCapability({
        description: "Fails with an internal error.",
        input: z.object({}),
        output: z.object({}),
        access: "public",
        async run() {
          throw new Error("secret database password leaked in a stack");
        },
      }),
      "support.bad-output": defineCapability({
        description: "Returns an invalid output.",
        input: z.object({}),
        output: z.object({ count: z.number() }),
        access: "public",
        async run() {
          return { count: "not a number" } as unknown as { count: number };
        },
      }),
      "support.unsafe-details": defineCapability({
        description: "Throws an error whose details cannot be serialized.",
        input: z.object({}),
        output: z.object({}),
        access: "public",
        async run() {
          throw new EngineError({
            code: "FORBIDDEN",
            message: "Denied with unsafe details.",
            publicDetails: { amount: 1n },
          });
        },
      }),
      "support.reserve": defineCapability({
        description: "Reserves a seat or reports a declared domain error.",
        input: z.object({ seat: z.string() }),
        output: z.object({ reserved: z.boolean() }),
        access: "public",
        errors: {
          SEAT_TAKEN: {
            description: "The seat is already reserved.",
            details: z.object({ seat: z.string() }),
            retryable: false,
          },
        },
        async run({ input }) {
          if (input.seat === "undeclared") {
            throw new CapabilityError("NOT_DECLARED");
          }
          throw new CapabilityError("SEAT_TAKEN", {
            details: { seat: input.seat },
          });
        },
      }),
      "support/slash id": defineCapability({
        description: "Has an ID that requires percent-encoding.",
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        access: "public",
        async run() {
          return { ok: true };
        },
      }),
    },
  });
}

function handlerFor(
  engine: Engine,
  options: Partial<HttpHandlerOptions> = {},
): (request: Request) => Promise<Response> {
  return createHttpHandler(engine, { auth: disabledAuth, ...options });
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(new URL(path, origin), { headers });
}

function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(new URL(path, origin), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function streamedPost(
  path: string,
  chunks: ReadonlyArray<Uint8Array>,
  headers: Record<string, string> = {},
): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Request(new URL(path, origin), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
    duplex: "half",
  });
}

async function errorOf(response: Response): Promise<{
  readonly code: string;
  readonly message: string;
  readonly publicDetails?: unknown;
}> {
  const body = (await response.json()) as {
    readonly error: {
      readonly code: string;
      readonly message: string;
      readonly publicDetails?: unknown;
    };
  };
  return body.error;
}

describe("createHttpHandler routes", () => {
  it("lists capabilities with defensive JSON response headers", async () => {
    const engine = createTestEngine();
    const response = await handlerFor(engine)(get("/capabilities"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.json()).toEqual({ capabilities: engine.list() });
  });

  it("describes one capability", async () => {
    const engine = createTestEngine();
    const response = await handlerFor(engine)(
      get("/capabilities/support.echo"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(engine.describe("support.echo"));
  });

  it("invokes one capability through engine.invoke with the http source", async () => {
    const contexts: ExecutionContext[] = [];
    const engine = createTestEngine({
      observe: (context) => contexts.push(context),
    });
    const invoke = vi.spyOn(engine, "invoke");
    const principal: Principal = { id: "user:42" };
    const handler = createHttpHandler(engine, {
      auth: { mode: "required", authenticate: () => principal },
    });

    const response = await handler(
      post("/capabilities/support.echo", { value: "hello" }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({
      value: "hello",
      principalId: "user:42",
      source: "http",
    });
    expect(invoke).toHaveBeenCalledExactlyOnceWith(
      "support.echo",
      { value: "hello" },
      expect.objectContaining({ source: "http", principal }),
    );
    expect(invoke.mock.calls[0]?.[2]?.signal).toBeInstanceOf(AbortSignal);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.source).toBe("http");
  });

  it("serves the generated OpenAPI document", async () => {
    const engine = createTestEngine();
    const response = await createHttpHandler(engine, {
      auth: { mode: "required", authenticate: () => ({ id: "user:1" }) },
    })(get("/openapi.json"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual(
      createHttpOpenApiDocument(engine, { security: "bearer" }),
    );
  });

  it("advertises no security scheme when authentication is disabled", async () => {
    const engine = createTestEngine();
    const response = await handlerFor(engine)(get("/openapi.json"));

    expect(await response.json()).toEqual(
      createHttpOpenApiDocument(engine, { security: "none" }),
    );
  });

  it("mounts every route below a configured base path", async () => {
    const engine = createTestEngine();
    const handler = handlerFor(engine, { basePath: "/api/support" });

    expect((await handler(get("/api/support/capabilities"))).status).toBe(200);
    expect(
      (await handler(get("/api/support/capabilities/support.echo"))).status,
    ).toBe(200);
    const document = (await (
      await handler(get("/api/support/openapi.json"))
    ).json()) as { readonly servers: unknown };
    expect(document.servers).toEqual([{ url: "/api/support" }]);
    expect((await handler(get("/capabilities"))).status).toBe(404);
    expect((await handler(get("/api/support/capabilities/"))).status).toBe(404);
    expect((await handler(get("/api/support"))).status).toBe(404);
    expect((await handler(get("/api/supportx/capabilities"))).status).toBe(404);
  });

  it("resolves a percent-encoded capability ID", async () => {
    const engine = createTestEngine();
    const path = `/capabilities/${encodeURIComponent("support/slash id")}`;

    const described = await handlerFor(engine)(get(path));
    const invoked = await handlerFor(engine)(post(path, {}));

    expect(described.status).toBe(200);
    expect(((await described.json()) as { readonly id: string }).id).toBe(
      "support/slash id",
    );
    expect(await invoked.json()).toEqual({ ok: true });
  });

  it("ignores the query string", async () => {
    const engine = createTestEngine();
    const response = await handlerFor(engine)(get("/capabilities?cache=1"));

    expect(response.status).toBe(200);
  });

  it("returns NOT_FOUND for unknown routes and CAPABILITY_NOT_FOUND for unknown capabilities", async () => {
    const engine = createTestEngine();
    const handler = handlerFor(engine);

    const route = await handler(get("/tools"));
    expect(route.status).toBe(404);
    expect(await errorOf(route)).toEqual({
      code: "NOT_FOUND",
      message: "The requested route does not exist.",
    });

    const nested = await handler(get("/capabilities/support.echo/invoke"));
    expect(nested.status).toBe(404);
    expect((await errorOf(nested)).code).toBe("NOT_FOUND");

    for (const request of [
      get("/capabilities/support.missing"),
      post("/capabilities/support.missing", {}),
    ]) {
      const response = await handler(request);
      expect(response.status).toBe(404);
      expect(await errorOf(response)).toEqual({
        code: "CAPABILITY_NOT_FOUND",
        message: "Capability not found.",
        publicDetails: { capabilityId: "support.missing" },
      });
    }
  });

  it("answers unknown capability IDs from the catalog without invoking or reading the body", async () => {
    const events: EngineEvent[] = [];
    const engine = createTestEngine({ onEvent: (event) => events.push(event) });
    const invoke = vi.spyOn(engine, "invoke");
    const handler = createHttpHandler(engine, {
      auth: { mode: "required", authenticate: () => ({ id: "user:1" }) },
    });
    const pull = vi.fn((controller: ReadableStreamDefaultController) => {
      controller.enqueue(new TextEncoder().encode("{}"));
      controller.close();
    });
    const attackerId = `attacker-controlled\n${"x".repeat(8_000)}`;
    let expected: unknown;
    try {
      engine.describe(attackerId as never);
    } catch (error) {
      const { code, message, publicDetails } = error as EngineError;
      expected = { code, message, publicDetails };
    }

    const invoked = await handler(
      new Request(
        new URL(`/capabilities/${encodeURIComponent(attackerId)}`, origin),
        {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: new ReadableStream({ pull }, { highWaterMark: 0 }),
          duplex: "half",
        },
      ),
    );
    const described = await handler(
      get(`/capabilities/${encodeURIComponent(attackerId)}`),
    );

    for (const response of [invoked, described]) {
      expect(response.status).toBe(404);
      expect(await errorOf(response)).toEqual(expected);
    }
    expect(pull).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("does not reveal the catalog to unauthenticated callers", async () => {
    const response = await createHttpHandler(createTestEngine(), {
      auth: { mode: "required", authenticate: () => null },
    })(post("/capabilities/support.missing", {}));

    expect(response.status).toBe(401);
    expect((await errorOf(response)).code).toBe("UNAUTHENTICATED");
  });

  it("rejects malformed percent-encoding in a capability segment", async () => {
    const response = await handlerFor(createTestEngine())(
      get("/capabilities/%E0%A4%A"),
    );

    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe("INVALID_REQUEST");
  });

  it("returns 405 with Allow for unsupported methods before authentication", async () => {
    const authenticate = vi.fn(() => ({ id: "user:1" }));
    const handler = createHttpHandler(createTestEngine(), {
      auth: { mode: "required", authenticate },
    });
    const cases = [
      ["/capabilities", "DELETE", "GET"],
      ["/capabilities", "POST", "GET"],
      ["/capabilities/support.echo", "PUT", "GET, POST"],
      ["/capabilities/support.echo", "HEAD", "GET, POST"],
      ["/capabilities/support.echo", "OPTIONS", "GET, POST"],
      ["/openapi.json", "POST", "GET"],
    ] as const;

    for (const [path, method, allow] of cases) {
      const response = await handler(
        new Request(new URL(path, origin), { method }),
      );
      expect(response.status, `${method} ${path}`).toBe(405);
      expect(response.headers.get("allow")).toBe(allow);
      if (method !== "HEAD") {
        expect((await errorOf(response)).code).toBe("METHOD_NOT_ALLOWED");
      }
    }
    expect(authenticate).not.toHaveBeenCalled();
  });
});

describe("createHttpHandler request bodies", () => {
  it("requires an application/json content type", async () => {
    const handler = handlerFor(createTestEngine());

    for (const contentType of [
      undefined,
      "text/plain",
      "application/jsonx",
      "application/json, text/plain",
    ]) {
      const response = await handler(
        new Request(new URL("/capabilities/support.echo", origin), {
          method: "POST",
          headers:
            contentType === undefined ? {} : { "content-type": contentType },
          body: JSON.stringify({ value: "x" }),
        }),
      );
      expect(response.status, String(contentType)).toBe(415);
      expect((await errorOf(response)).code).toBe("UNSUPPORTED_MEDIA_TYPE");
    }

    const parameterized = await handler(
      post(
        "/capabilities/support.echo",
        { value: "x" },
        {
          "content-type": "Application/JSON; charset=utf-8",
        },
      ),
    );
    expect(parameterized.status).toBe(200);
  });

  it("rejects malformed JSON and invalid UTF-8 without invoking", async () => {
    const engine = createTestEngine();
    const invoke = vi.spyOn(engine, "invoke");
    const handler = handlerFor(engine);

    for (const request of [
      post("/capabilities/support.echo", "{"),
      post("/capabilities/support.echo", ""),
      streamedPost("/capabilities/support.echo", [
        new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d]),
      ]),
      streamedPost("/capabilities/support.echo", [
        new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xe2, 0x82]),
      ]),
    ]) {
      const response = await handler(request);
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toEqual({
        code: "INVALID_JSON",
        message: "The request body must be valid UTF-8 JSON.",
      });
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it("decodes multibyte UTF-8 split across body chunks", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ value: "ação" }));
    const split = bytes.indexOf(0xc3) + 1;
    const response = await handlerFor(createTestEngine())(
      streamedPost("/capabilities/support.echo", [
        bytes.slice(0, split),
        bytes.slice(split),
      ]),
    );

    expect(response.status).toBe(200);
    expect(((await response.json()) as { readonly value: string }).value).toBe(
      "ação",
    );
  });

  it("leaves non-object JSON to the capability input contract", async () => {
    const response = await handlerFor(createTestEngine())(
      post("/capabilities/support.echo", []),
    );

    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe("INPUT_INVALID");
  });

  it("rejects a declared oversized body before authentication", async () => {
    const authenticate = vi.fn(() => ({ id: "user:1" }));
    const handler = createHttpHandler(createTestEngine(), {
      maxRequestBodyBytes: 16,
      auth: { mode: "required", authenticate },
    });

    const response = await handler(
      post("/capabilities/support.echo", "{}", { "content-length": "17" }),
    );

    expect(response.status).toBe(413);
    expect(await errorOf(response)).toEqual({
      code: "PAYLOAD_TOO_LARGE",
      message: "The request body exceeds the configured limit.",
    });
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("enforces the streamed body limit inclusively", async () => {
    const engine = createTestEngine();
    const invoke = vi.spyOn(engine, "invoke");
    const handler = handlerFor(engine, { maxRequestBodyBytes: 16 });

    const accepted = await handler(
      streamedPost("/capabilities/support.echo", [
        new TextEncoder().encode('{"value":"1234"}'),
      ]),
    );
    expect(accepted.status).toBe(200);

    const rejected = await handler(
      streamedPost("/capabilities/support.echo", [
        new TextEncoder().encode('{"value":'),
        new TextEncoder().encode('"12345"}'),
      ]),
    );
    expect(rejected.status).toBe(413);
    expect((await errorOf(rejected)).code).toBe("PAYLOAD_TOO_LARGE");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("defaults the body limit to 1,048,576 bytes", async () => {
    const handler = handlerFor(createTestEngine());
    const value = "x".repeat(1_048_576 - '{"value":""}'.length);

    const accepted = await handler(
      post("/capabilities/support.echo", { value }),
    );
    expect(accepted.status).toBe(200);
    await accepted.arrayBuffer();

    const rejected = await handler(
      post("/capabilities/support.echo", { value: `${value}x` }),
    );
    expect(rejected.status).toBe(413);
  });

  it("validates the configured body limit", () => {
    for (const maxRequestBodyBytes of [0, -1, 1.5, Number.NaN, 2 ** 53]) {
      expect(() =>
        handlerFor(createTestEngine(), { maxRequestBodyBytes }),
      ).toThrow(TypeError);
    }
  });
});

describe("createHttpHandler error mapping", () => {
  const cases = [
    ["support.echo", { value: 1 }, 400, "INPUT_INVALID"],
    ["support.private", {}, 401, "UNAUTHENTICATED"],
    ["support.denied", {}, 403, "FORBIDDEN"],
    ["support.missing", {}, 404, "CAPABILITY_NOT_FOUND"],
    ["support.bad-output", {}, 500, "OUTPUT_INVALID"],
    ["support.broken", {}, 500, "EXECUTION_FAILED"],
    ["support.slow", {}, 503, "CANCELLED"],
    ["support.reserve", { seat: "12A" }, 422, "DOMAIN_ERROR"],
  ] as const;

  it.each(cases)(
    "maps %s with input %j to HTTP %i with the sanitized %s body",
    async (capabilityId, input, status, code) => {
      const handler =
        code === "UNAUTHENTICATED"
          ? handlerFor(createTestEngine())
          : createHttpHandler(createTestEngine(), {
              auth: { mode: "required", authenticate: () => ({ id: "u:1" }) },
            });
      const response = await handler(
        post(`/capabilities/${capabilityId}`, input),
      );

      expect(response.status).toBe(status);
      expect(response.headers.get("content-type")).toBe("application/json");
      const text = await response.text();
      const body = JSON.parse(text) as {
        readonly error: Readonly<Record<string, unknown>>;
      };
      expect(Object.keys(body)).toEqual(["error"]);
      expect(body.error.code).toBe(code);
      expect(typeof body.error.message).toBe("string");
      expect(
        Object.keys(body.error).every((key) =>
          ["code", "message", "publicDetails"].includes(key),
        ),
      ).toBe(true);
      expect(text).not.toContain("secret");
      expect(text).not.toContain("stack");
      expect(text).not.toContain("cause");
    },
  );

  it("maps a declared domain error to 422 with its public details", async () => {
    const handler = handlerFor(createTestEngine());

    const declared = await handler(
      post("/capabilities/support.reserve", { seat: "12A" }),
    );
    expect(declared.status).toBe(422);
    expect(await errorOf(declared)).toEqual({
      code: "DOMAIN_ERROR",
      message: "The seat is already reserved.",
      publicDetails: {
        code: "SEAT_TAKEN",
        retryable: false,
        details: { seat: "12A" },
      },
    });

    const undeclared = await handler(
      post("/capabilities/support.reserve", { seat: "undeclared" }),
    );
    expect(undeclared.status).toBe(500);
    expect((await errorOf(undeclared)).code).toBe("EXECUTION_FAILED");
  });

  it("issues a Bearer challenge for every 401", async () => {
    const response = await handlerFor(createTestEngine())(
      post("/capabilities/support.private", {}),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("keeps input validation details public", async () => {
    const response = await handlerFor(createTestEngine())(
      post("/capabilities/support.echo", { value: 1 }),
    );

    expect(await errorOf(response)).toMatchObject({
      code: "INPUT_INVALID",
      publicDetails: { issues: [expect.objectContaining({ path: ["value"] })] },
    });
  });

  it("falls back to a generic error when public details cannot be serialized", async () => {
    const response = await handlerFor(createTestEngine())(
      post("/capabilities/support.unsafe-details", {}),
    );

    expect(response.status).toBe(500);
    expect(await errorOf(response)).toEqual({
      code: "EXECUTION_FAILED",
      message: "Capability execution failed.",
    });
  });

  it("never rejects when the engine itself fails unexpectedly", async () => {
    const engine = createTestEngine();
    let failing = false;
    const broken: Engine = {
      name: engine.name,
      version: engine.version,
      invoke: engine.invoke,
      describe: engine.describe,
      list: () => {
        if (failing) throw new Error("secret catalog failure");
        return engine.list();
      },
    };
    const handler = handlerFor(broken);
    failing = true;
    const response = await handler(get("/capabilities"));

    expect(response.status).toBe(500);
    expect(await errorOf(response)).toEqual({
      code: "INTERNAL_ERROR",
      message: "The request could not be processed.",
    });
  });
});

describe("createHttpHandler authentication", () => {
  it("passes a frozen structural request view to the authenticator", async () => {
    let received: HttpAuthenticationRequest | undefined;
    const handler = createHttpHandler(createTestEngine(), {
      basePath: "/api",
      auth: {
        mode: "required",
        authenticate(request) {
          received = request;
          return { id: "user:42" };
        },
      },
    });

    await handler(
      post(
        "/api/capabilities/support.echo?x=1",
        { value: "x" },
        {
          authorization: "Bearer token",
        },
      ),
    );

    expect(received).toBeDefined();
    expect(Object.isFrozen(received)).toBe(true);
    expect(Object.isFrozen(received?.headers)).toBe(true);
    expect(received?.path).toBe("/api/capabilities/support.echo");
    expect(received?.method).toBe("POST");
    expect(received?.headers.get("Authorization")).toBe("Bearer token");
    expect(received?.headers.has("authorization")).toBe(true);
    expect(received?.headers.has("x-missing")).toBe(false);
    expect(received?.headers.get("x-missing")).toBeNull();
    expect(received?.signal).toBeInstanceOf(AbortSignal);
    expect(Object.keys(received ?? {}).sort()).toEqual([
      "headers",
      "method",
      "path",
      "signal",
    ]);
  });

  it("protects every route and never runs a capability without identity", async () => {
    const contexts: ExecutionContext[] = [];
    const engine = createTestEngine({
      observe: (context) => contexts.push(context),
    });
    const handler = createHttpHandler(engine, {
      auth: { mode: "required", authenticate: () => null },
    });

    for (const request of [
      get("/capabilities"),
      get("/capabilities/support.echo"),
      get("/openapi.json"),
      post("/capabilities/support.echo", { value: "x" }),
      post("/capabilities/support.echo", "not json", {
        "content-type": "text/plain",
      }),
    ]) {
      const response = await handler(request);
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
      expect(await errorOf(response)).toEqual({
        code: "UNAUTHENTICATED",
        message: "Authentication is required.",
      });
    }
    expect(contexts).toEqual([]);
  });

  it("treats a malformed principal as unauthenticated", async () => {
    for (const principal of [
      { id: "" },
      { id: 42 },
      { id: "user:1", attributes: [] },
      { id: "user:1", attributes: { callback: () => undefined } },
      "user:1",
    ]) {
      const handler = createHttpHandler(createTestEngine(), {
        auth: {
          mode: "required",
          authenticate: () => principal as unknown as Principal,
        },
      });
      const response = await handler(get("/capabilities"));
      expect(response.status).toBe(401);
    }
  });

  it("snapshots the authenticated principal before reading the body", async () => {
    const principal = { id: "user:1", attributes: { role: "reader" } };
    const handler = createHttpHandler(createTestEngine(), {
      auth: { mode: "required", authenticate: () => principal },
    });
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          principal.id = "attacker";
          controller.enqueue(new TextEncoder().encode('{"value":"x"}'));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );

    const response = await handler(
      new Request(new URL("/capabilities/support.echo", origin), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        duplex: "half",
      }),
    );

    expect(principal.id).toBe("attacker");
    expect(
      ((await response.json()) as { readonly principalId: string }).principalId,
    ).toBe("user:1");
  });

  it("maps an authenticator failure to a sanitized 500", async () => {
    const handler = createHttpHandler(createTestEngine(), {
      auth: {
        mode: "required",
        authenticate() {
          throw new Error("secret verifier outage");
        },
      },
    });

    const response = await handler(get("/capabilities"));
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(text)).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "The request could not be processed.",
      },
    });
    expect(text).not.toContain("secret");
  });

  it("rejects invalid authentication configuration before serving", () => {
    const engine = createTestEngine();
    for (const auth of [
      undefined,
      null,
      {},
      { mode: "optional" },
      { mode: "required" },
      { mode: "required", authenticate: "token" },
    ]) {
      expect(() =>
        createHttpHandler(engine, {
          auth: auth as unknown as HttpAuthOptions,
        }),
      ).toThrow(TypeError);
    }
    expect(() =>
      createHttpHandler(engine, undefined as unknown as HttpHandlerOptions),
    ).toThrow(TypeError);
  });

  it("snapshots the authentication hook at construction", async () => {
    const auth = {
      mode: "required" as const,
      authenticate: (): Principal | null => ({ id: "user:1" }),
    };
    const handler = createHttpHandler(createTestEngine(), { auth });
    auth.authenticate = () => null;

    expect((await handler(get("/capabilities"))).status).toBe(200);
  });
});

describe("createHttpHandler host and origin boundaries", () => {
  it("accepts only loopback hosts by default and checks hosts before authentication", async () => {
    const authenticate = vi.fn(() => ({ id: "user:1" }));
    const handler = createHttpHandler(createTestEngine(), {
      auth: { mode: "required", authenticate },
    });

    for (const host of [
      "localhost:3000",
      "127.0.0.1:8080",
      "[::1]",
      "LOCALHOST",
    ]) {
      const response = await handler(
        new Request(`http://${host}/capabilities`),
      );
      expect(response.status, host).toBe(200);
    }
    authenticate.mockClear();

    const rejected = await handler(
      new Request("http://engine.example/capabilities"),
    );
    expect(rejected.status).toBe(403);
    expect(await errorOf(rejected)).toEqual({
      code: "HOST_NOT_ALLOWED",
      message: "The request host is not allowed.",
    });
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("uses a configured exact host allowlist", async () => {
    const handler = handlerFor(createTestEngine(), {
      allowedHosts: ["Engine.Example"],
    });

    expect(
      (await handler(new Request("https://engine.example:8443/capabilities")))
        .status,
    ).toBe(200);
    expect(
      (await handler(new Request("http://localhost/capabilities"))).status,
    ).toBe(403);
    expect(
      (await handler(new Request("http://api.engine.example/capabilities")))
        .status,
    ).toBe(403);
  });

  it("validates the host allowlist", () => {
    for (const allowedHosts of [
      [],
      ["https://engine.example"],
      ["engine.example/path"],
      ["user@engine.example"],
      [""],
    ]) {
      expect(() => handlerFor(createTestEngine(), { allowedHosts })).toThrow(
        TypeError,
      );
    }
  });

  it("rejects every Origin when CORS is not configured", async () => {
    const authenticate = vi.fn(() => ({ id: "user:1" }));
    const handler = createHttpHandler(createTestEngine(), {
      auth: { mode: "required", authenticate },
    });

    const response = await handler(
      get("/capabilities", { origin: "http://localhost:3000" }),
    );

    expect(response.status).toBe(403);
    expect(await errorOf(response)).toEqual({
      code: "ORIGIN_NOT_ALLOWED",
      message: "The request origin is not allowed.",
    });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(authenticate).not.toHaveBeenCalled();
  });
});

describe("createHttpHandler CORS", () => {
  const cors = {
    allowedOrigins: ["https://console.example", "http://localhost:5173"],
  } as const;

  it("reflects only an allowed origin on actual responses, including errors", async () => {
    const handler = createHttpHandler(createTestEngine(), {
      cors,
      auth: { mode: "required", authenticate: () => null },
    });

    const response = await handler(
      get("/capabilities", { origin: "https://console.example" }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://console.example",
    );
    expect(response.headers.get("vary")).toBe("Origin");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();

    const sameOriginless = await handlerFor(createTestEngine(), { cors })(
      get("/capabilities"),
    );
    expect(sameOriginless.status).toBe(200);
    expect(
      sameOriginless.headers.get("access-control-allow-origin"),
    ).toBeNull();
    expect(sameOriginless.headers.get("vary")).toBe("Origin");
  });

  it("rejects origins outside the allowlist", async () => {
    const handler = handlerFor(createTestEngine(), { cors });

    for (const value of [
      "https://evil.example",
      "https://console.example:8443",
      "http://console.example",
      "null",
      "not an origin",
    ]) {
      const response = await handler(get("/capabilities", { origin: value }));
      expect(response.status, value).toBe(403);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  it("answers a preflight for an allowed origin before authentication", async () => {
    const authenticate = vi.fn(() => ({ id: "user:1" }));
    const handler = createHttpHandler(createTestEngine(), {
      cors: { ...cors, allowedHeaders: ["X-API-Key"], maxAgeSeconds: 600 },
      auth: { mode: "required", authenticate },
    });

    const response = await handler(
      new Request(new URL("/capabilities/support.echo", origin), {
        method: "OPTIONS",
        headers: {
          origin: "http://localhost:5173",
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization, content-type",
        },
      }),
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:5173",
    );
    expect(response.headers.get("access-control-allow-methods")).toBe(
      "GET, POST",
    );
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "authorization, content-type, x-api-key",
    );
    expect(response.headers.get("access-control-max-age")).toBe("600");
    expect(response.headers.get("vary")).toBe(
      "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
    );
    expect(response.headers.get("content-type")).toBeNull();
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("omits max age unless configured and lists read-only route methods", async () => {
    const response = await handlerFor(createTestEngine(), { cors })(
      new Request(new URL("/openapi.json", origin), {
        method: "OPTIONS",
        headers: {
          origin: "https://console.example",
          "access-control-request-method": "GET",
        },
      }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toBe("GET");
    expect(response.headers.get("access-control-max-age")).toBeNull();
  });

  it("does not answer preflights for unknown routes or disallowed origins", async () => {
    const handler = handlerFor(createTestEngine(), { cors });
    const preflight = (path: string, requestOrigin: string) =>
      new Request(new URL(path, origin), {
        method: "OPTIONS",
        headers: {
          origin: requestOrigin,
          "access-control-request-method": "POST",
        },
      });

    expect(
      (await handler(preflight("/unknown", "https://console.example"))).status,
    ).toBe(404);
    expect(
      (await handler(preflight("/capabilities", "https://evil.example")))
        .status,
    ).toBe(403);
    expect(
      (
        await handlerFor(createTestEngine())(
          preflight("/capabilities", "https://console.example"),
        )
      ).status,
    ).toBe(403);
  });

  it("validates CORS configuration", () => {
    for (const invalid of [
      { allowedOrigins: [] },
      { allowedOrigins: ["*"] },
      { allowedOrigins: ["https://console.example/path"] },
      { allowedOrigins: ["ftp://console.example"] },
      {
        allowedOrigins: ["https://console.example"],
        allowedHeaders: ["bad header"],
      },
      { allowedOrigins: ["https://console.example"], maxAgeSeconds: -1 },
      { allowedOrigins: ["https://console.example"], maxAgeSeconds: 1.5 },
      { allowedOrigins: ["https://console.example"], maxAgeSeconds: 86_401 },
    ]) {
      expect(() =>
        handlerFor(createTestEngine(), {
          cors: invalid as unknown as HttpCorsOptions,
        }),
      ).toThrow(TypeError);
    }
  });
});

describe("createHttpHandler configuration", () => {
  it("validates the base path", () => {
    for (const basePath of [
      "",
      "api",
      "/api/",
      "//api",
      "/a/../b",
      "/a/./b",
      "/a%20b",
      "/a?x",
      "/a#x",
      "/a b",
      `/${"a".repeat(256)}`,
    ]) {
      expect(() => handlerFor(createTestEngine(), { basePath })).toThrow(
        TypeError,
      );
    }
    expect(() =>
      handlerFor(createTestEngine(), { basePath: "/" }),
    ).not.toThrow();
    expect(() =>
      handlerFor(createTestEngine(), { basePath: "/v1/engines/support" }),
    ).not.toThrow();
  });
});

describe("createHttpHandler cancellation and events", () => {
  it("cancels the invocation when the client disconnects", async () => {
    let capabilitySignal: AbortSignal | undefined;
    let authenticationSignal: AbortSignal | undefined;
    const started = Promise.withResolvers<void>();
    const engine = createTestEngine({
      observe: (context) => {
        capabilitySignal = context.signal;
        started.resolve();
      },
    });
    const handler = createHttpHandler(engine, {
      auth: {
        mode: "required",
        authenticate(request) {
          authenticationSignal = request.signal;
          return { id: "user:1" };
        },
      },
    });
    const client = new AbortController();

    const pending = handler(
      new Request(new URL("/capabilities/support.wait", origin), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: client.signal,
      }),
    );
    await started.promise;
    client.abort();
    const response = await pending;

    expect(capabilitySignal?.aborted).toBe(true);
    expect(authenticationSignal?.aborted).toBe(true);
    expect(response.status).toBe(503);
    expect((await errorOf(response)).code).toBe("CANCELLED");
  });

  it("emits engine events with the http source", async () => {
    const events: EngineEvent[] = [];
    const handler = handlerFor(
      createTestEngine({ onEvent: (event) => events.push(event) }),
    );

    await handler(post("/capabilities/support.echo", { value: "x" }));

    expect(events.map((event) => event.type)).toEqual([
      "invocation.started",
      "invocation.completed",
    ]);
    expect(events[0]).toMatchObject({
      capabilityId: "support.echo",
      source: "http",
    });
  });
});
