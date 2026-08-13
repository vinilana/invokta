import process from "node:process";

import {
  createEngine,
  defineCapability,
  EngineError,
  type ExecutionContext,
  type Principal,
} from "@invokta/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ErrorCode,
  LATEST_PROTOCOL_VERSION,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { serveMcpStdio } from "../src/index.js";
import { createMcpServer } from "../src/protocol-server.js";

const openClients: Client[] = [];

function processListenerCounts() {
  return {
    stdinData: process.stdin.listenerCount("data"),
    stdinEnd: process.stdin.listenerCount("end"),
    stdinClose: process.stdin.listenerCount("close"),
    stdoutError: process.stdout.listenerCount("error"),
  };
}

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close()));
});

async function connect(
  engine: Parameters<typeof createMcpServer>[0],
  principal: Principal | null = {
    id: "local:mcp-host",
    attributes: { team: "support" },
  },
) {
  const server = createMcpServer(engine, {
    principal,
    source: "mcp-stdio",
  });
  const client = new Client(
    { name: "mcp-adapter-test", version: "0.0.0-test" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  openClients.push(client);
  return { client, server };
}

function toolErrorPayload(result: unknown): unknown {
  const content = (result as { content: [{ type: "text"; text: string }] })
    .content;
  return JSON.parse(content[0].text) as unknown;
}

function createEchoEngine(
  observeContext: (context: ExecutionContext) => void = () => undefined,
) {
  return createEngine({
    name: "support-engine",
    version: "0.1.0",
    capabilities: {
      "support.echo": defineCapability({
        title: "Echo support text",
        description: "Returns normalized support text.",
        input: z.object({ text: z.string().trim().min(1) }),
        output: z.object({ echoed: z.string() }),
        access: "authenticated",
        annotations: {
          readOnly: true,
          destructive: false,
          idempotent: true,
          openWorld: false,
        },
        async run({ input, context }) {
          observeContext(context);
          return { echoed: input.text };
        },
      }),
    },
  });
}

describe("MCP stdio protocol adapter", () => {
  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY])(
    "rejects the invalid stdio read-buffer limit %j before starting",
    async (maxReadBufferBytes) => {
      const initialListeners = processListenerCounts();
      await expect(
        serveMcpStdio(createEchoEngine(), { maxReadBufferBytes }),
      ).rejects.toThrow("maxReadBufferBytes must be a positive safe integer.");
      expect(processListenerCounts()).toEqual(initialListeners);
    },
  );

  it("negotiates the baseline protocol and maps each capability to one portable tool", async () => {
    expect(LATEST_PROTOCOL_VERSION).toBe("2025-11-25");
    const engine = createEchoEngine();
    const { client } = await connect(engine);

    expect(client.getServerVersion()).toEqual({
      name: "support-engine",
      version: "0.1.0",
    });
    const listed = await client.listTools();

    expect(listed.tools).toEqual([
      {
        name: "support_echo",
        title: "Echo support text",
        description: "Returns normalized support text.",
        inputSchema: engine.describe("support.echo").inputSchema,
        outputSchema: engine.describe("support.echo").outputSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
    ]);
  });

  it("calls engine.invoke with the trusted principal and MCP stdio source", async () => {
    const observeContext = vi.fn<(context: ExecutionContext) => void>();
    const { client } = await connect(createEchoEngine(observeContext));

    const result = await client.callTool({
      name: "support_echo",
      arguments: { text: "  hello  " },
    });

    expect(result).toEqual({
      content: [{ type: "text", text: '{"echoed":"hello"}' }],
      structuredContent: { echoed: "hello" },
    });
    expect(observeContext).toHaveBeenCalledTimes(1);
    expect(observeContext.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        source: "mcp-stdio",
        principal: {
          id: "local:mcp-host",
          attributes: { team: "support" },
        },
      }),
    );
  });

  it("normalizes unsupported characters and bounds long MCP tool names", async () => {
    const longCapabilityId = "a".repeat(65);
    const engine = createEngine({
      name: "portable-tool-name-engine",
      version: "0.1.0",
      capabilities: {
        "": defineCapability({
          description: "Uses an empty capability ID.",
          input: z.object({}),
          output: z.object({ id: z.string() }),
          access: "public",
          async run() {
            return { id: "" };
          },
        }),
        "already-compatible_1": defineCapability({
          description: "Uses an already portable capability ID.",
          input: z.object({}),
          output: z.object({ id: z.string() }),
          access: "public",
          async run() {
            return { id: "already-compatible_1" };
          },
        }),
        "knowledge/ação": defineCapability({
          description: "Uses non-ASCII and separator characters.",
          input: z.object({}),
          output: z.object({ id: z.string() }),
          access: "public",
          async run() {
            return { id: "knowledge/ação" };
          },
        }),
        [longCapabilityId]: defineCapability({
          description: "Uses a capability ID longer than the MCP limit.",
          input: z.object({}),
          output: z.object({ id: z.string() }),
          access: "public",
          async run() {
            return { id: longCapabilityId };
          },
        }),
      },
    });
    const { client } = await connect(engine);

    const listed = await client.listTools();

    expect(listed.tools.map(({ name }) => name)).toEqual([
      "_",
      "already-compatible_1",
      "knowledge_a__o",
      `${"a".repeat(51)}_635361c48bb9`,
    ]);
    for (const { name } of listed.tools) {
      expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/u);
    }
    await expect(
      client.callTool({ name: "knowledge_a__o", arguments: {} }),
    ).resolves.toMatchObject({ structuredContent: { id: "knowledge/ação" } });
  });

  it("rejects capability IDs that resolve to the same MCP tool name", () => {
    const capability = defineCapability({
      description: "Creates a tool-name collision fixture.",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      access: "public",
      async run() {
        return { ok: true };
      },
    });
    const engine = createEngine({
      name: "colliding-tool-name-engine",
      version: "0.1.0",
      capabilities: {
        "support.echo": capability,
        support_echo: capability,
      },
    });

    expect(() =>
      createMcpServer(engine, {
        principal: null,
        source: "mcp-stdio",
      }),
    ).toThrow(
      'Capabilities "support.echo" and "support_echo" resolve to duplicate MCP tool name "support_echo".',
    );
  });

  it("rejects domain IDs and unknown names not published by tools/list", async () => {
    const { client } = await connect(createEchoEngine());

    await expect(
      client.callTool({ name: "support.echo", arguments: {} }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(
      client.callTool({ name: "support_missing", arguments: {} }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it("maps engine failures to safe tool execution errors", async () => {
    const engine = createEngine({
      name: "failing-engine",
      version: "0.1.0",
      capabilities: {
        "support.fail": defineCapability({
          description: "Fails with a public domain error.",
          input: z.object({ ticketId: z.string() }),
          output: z.object({ ok: z.boolean() }),
          access: "public",
          async run({ input }) {
            throw new EngineError({
              code: "EXECUTION_FAILED",
              message: "Ticket processing failed.",
              publicDetails: { ticketId: input.ticketId },
              cause: new Error("secret provider token: top-secret"),
            });
          },
        }),
      },
    });
    const { client } = await connect(engine);

    const result = await client.callTool({
      name: "support_fail",
      arguments: { ticketId: "T-1" },
    });

    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            code: "EXECUTION_FAILED",
            message: "Ticket processing failed.",
            publicDetails: { ticketId: "T-1" },
          }),
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("top-secret");
    expect(JSON.stringify(result)).not.toContain("stack");
    expect(JSON.stringify(result)).not.toContain("cause");
  });

  it.each([
    {
      name: "a throwing code getter",
      createError() {
        const error = new EngineError({
          code: "EXECUTION_FAILED",
          message: "Safe public message.",
        });
        Object.defineProperty(error, "code", {
          get() {
            throw new Error("secret-code-getter");
          },
        });
        return error;
      },
    },
    {
      name: "a mutated code",
      createError() {
        const error = new EngineError({
          code: "EXECUTION_FAILED",
          message: "Safe public message.",
        });
        Object.defineProperty(error, "code", {
          value: "secret-invalid-code",
        });
        return error;
      },
    },
    {
      name: "a throwing message getter",
      createError() {
        const error = new EngineError({
          code: "EXECUTION_FAILED",
          message: "Safe public message.",
        });
        Object.defineProperty(error, "message", {
          get() {
            throw new Error("secret-message-getter");
          },
        });
        return error;
      },
    },
    {
      name: "a mutated message",
      createError() {
        const error = new EngineError({
          code: "EXECUTION_FAILED",
          message: "Safe public message.",
        });
        Object.defineProperty(error, "message", {
          value: { secret: "secret-invalid-message" },
        });
        return error;
      },
    },
    {
      name: "a throwing publicDetails getter",
      createError() {
        const error = new EngineError({
          code: "EXECUTION_FAILED",
          message: "Safe public message.",
        });
        Object.defineProperty(error, "publicDetails", {
          get() {
            throw new Error("secret-details-getter");
          },
        });
        return error;
      },
    },
    {
      name: "a throwing publicDetails proxy",
      createError() {
        return new EngineError({
          code: "EXECUTION_FAILED",
          message: "Safe public message.",
          publicDetails: new Proxy(
            {},
            {
              get() {
                throw new Error("secret-details-proxy");
              },
            },
          ),
        });
      },
    },
    {
      name: "a throwing EngineError proxy",
      createError() {
        return new Proxy(
          new EngineError({
            code: "EXECUTION_FAILED",
            message: "Safe public message.",
          }),
          {
            getPrototypeOf() {
              throw new Error("secret-error-proxy");
            },
          },
        );
      },
    },
  ])(
    "sanitizes $name without producing a protocol error",
    async ({ createError }) => {
      const engine = createEchoEngine();
      Object.defineProperty(engine, "invoke", {
        value: async () => {
          throw createError();
        },
      });
      const { client } = await connect(engine);

      const result = await client.callTool({
        name: "support_echo",
        arguments: { text: "hello" },
      });

      expect(result).toEqual({
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
      });
      expect(JSON.stringify(result)).not.toContain("secret-");
    },
  );

  it("maps input and output validation failures to tool execution errors", async () => {
    const invalidInputClient = (await connect(createEchoEngine())).client;

    const inputResult = await invalidInputClient.callTool({
      name: "support_echo",
      arguments: { text: "   " },
    });
    expect(inputResult.isError).toBe(true);
    expect(toolErrorPayload(inputResult)).toMatchObject({
      code: "INPUT_INVALID",
      message: "Capability input validation failed.",
    });

    const invalidOutputEngine = createEngine({
      name: "invalid-output-engine",
      version: "0.1.0",
      capabilities: {
        "support.invalid-output": defineCapability({
          description: "Returns an invalid output for boundary testing.",
          input: z.object({}),
          output: z.object({ ok: z.boolean() }),
          access: "public",
          async run() {
            return { ok: "not-a-boolean" } as unknown as { ok: boolean };
          },
        }),
      },
    });
    const invalidOutputClient = (await connect(invalidOutputEngine)).client;

    const outputResult = await invalidOutputClient.callTool({
      name: "support_invalid-output",
      arguments: {},
    });
    expect(outputResult.isError).toBe(true);
    expect(toolErrorPayload(outputResult)).toMatchObject({
      code: "OUTPUT_INVALID",
      message: "Capability output validation failed.",
    });
  });

  it("keeps an omitted stdio principal anonymous", async () => {
    const run = vi.fn(async () => ({ ok: true }));
    const engine = createEngine({
      name: "anonymous-engine",
      version: "0.1.0",
      capabilities: {
        "support.authenticated": defineCapability({
          description: "Requires a trusted local principal.",
          input: z.object({}),
          output: z.object({ ok: z.boolean() }),
          access: "authenticated",
          run,
        }),
      },
    });
    const { client } = await connect(engine, null);

    const result = await client.callTool({
      name: "support_authenticated",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(toolErrorPayload(result)).toEqual({
      code: "UNAUTHENTICATED",
      message: "Authentication is required.",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("normalizes unknown handler failures without exposing their details", async () => {
    const engine = createEngine({
      name: "unsafe-engine",
      version: "0.1.0",
      capabilities: {
        "support.unsafe": defineCapability({
          description: "Fails unexpectedly.",
          input: z.object({}),
          output: z.object({ ok: z.boolean() }),
          access: "public",
          async run() {
            throw new Error("database password: top-secret");
          },
        }),
      },
    });
    const { client } = await connect(engine);

    const result = await client.callTool({
      name: "support_unsafe",
      arguments: {},
    });

    expect(result).toEqual({
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
    });
    expect(JSON.stringify(result)).not.toContain("top-secret");
  });

  it("denies access before the capability handler runs", async () => {
    const run = vi.fn(async () => ({ ok: true }));
    const engine = createEngine({
      name: "protected-engine",
      version: "0.1.0",
      capabilities: {
        "support.protected": defineCapability({
          description: "Requires a different local principal.",
          input: z.object({}),
          output: z.object({ ok: z.boolean() }),
          access: ({ principal }) => principal?.id === "local:administrator",
          run,
        }),
      },
    });
    const { client } = await connect(engine);

    const result = await client.callTool({
      name: "support_protected",
      arguments: {},
    });

    expect(result).toEqual({
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
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("propagates client cancellation to the capability AbortSignal", async () => {
    let observeStart!: () => void;
    const started = new Promise<void>((resolve) => {
      observeStart = resolve;
    });
    let observeCancellation!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      observeCancellation = resolve;
    });
    const engine = createEngine({
      name: "cancellable-engine",
      version: "0.1.0",
      capabilities: {
        "support.wait": defineCapability({
          description: "Waits until cancelled.",
          input: z.object({}),
          output: z.object({ done: z.boolean() }),
          access: "public",
          async run({ context }) {
            observeStart();
            context.signal.addEventListener(
              "abort",
              () => observeCancellation(),
              { once: true },
            );
            return await new Promise(() => undefined);
          },
        }),
      },
    });
    const { client } = await connect(engine);
    const controller = new AbortController();

    const invocation = client.callTool(
      { name: "support_wait", arguments: {} },
      undefined,
      { signal: controller.signal },
    );
    await started;
    controller.abort();

    await expect(invocation).rejects.toThrow();
    await expect(cancelled).resolves.toBeUndefined();
  });
});
