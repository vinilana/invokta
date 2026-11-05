import { createEngine, defineCapability } from "@invokta/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  JSONRPCMessage,
  Progress,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { type McpHttpServerHandle, serveMcpHttp } from "../src/index.js";
import { createMcpServer } from "../src/protocol-server.js";
import { preserveFalsyRequestIds } from "../src/request-id-transport.js";

const openServers: McpHttpServerHandle[] = [];
const openClients: Client[] = [];

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close()));
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

const stepSchema = z.object({
  progress: z.number().optional(),
  total: z.number().optional(),
  message: z.string().optional(),
  waitMs: z.number().int().min(0).max(1_000).optional(),
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A capability that follows a script of progress reports and pauses, then
 * optionally waits for an external release or for cancellation.
 */
function createScriptEngine(
  hooks: {
    readonly beforeReturn?: () => Promise<void>;
    readonly onAbort?: () => void;
  } = {},
) {
  return createEngine({
    name: "progress-engine",
    version: "0.1.0",
    capabilities: {
      "media.render": defineCapability({
        description: "Reports scripted progress while rendering.",
        input: z.object({ steps: z.array(stepSchema).max(20) }),
        output: z.object({ rendered: z.boolean() }),
        access: "public",
        async run({ input, context }) {
          context.signal.addEventListener("abort", () => hooks.onAbort?.(), {
            once: true,
          });
          for (const step of input.steps) {
            if (step.waitMs !== undefined) await sleep(step.waitMs);
            if (step.progress !== undefined) {
              context.reportProgress({
                progress: step.progress,
                ...(step.total === undefined ? {} : { total: step.total }),
                ...(step.message === undefined
                  ? {}
                  : { message: step.message }),
              });
            }
          }
          await hooks.beforeReturn?.();
          return { rendered: true };
        },
      }),
    },
  });
}

type Step = z.input<typeof stepSchema>;

function toolCall(
  id: string | number,
  steps: ReadonlyArray<Step>,
  meta?: Readonly<Record<string, unknown>>,
): JSONRPCMessage {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: "media_render",
      arguments: { steps },
      ...(meta === undefined ? {} : { _meta: meta }),
    },
  } as JSONRPCMessage;
}

async function connectRaw(engine = createScriptEngine()) {
  const server = createMcpServer(engine, {
    principal: null,
    source: "mcp-stdio",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const received: JSONRPCMessage[] = [];
  clientTransport.onmessage = (message) => {
    received.push(message);
  };
  await server.connect(preserveFalsyRequestIds(serverTransport));
  await clientTransport.start();
  const responseFor = async (id: string | number) => {
    await vi.waitFor(() =>
      expect(
        received.some(
          (message) =>
            "id" in message && message.id === id && "result" in message,
        ),
      ).toBe(true),
    );
  };
  return {
    received,
    send: (message: JSONRPCMessage) => clientTransport.send(message),
    responseFor,
    progressNotifications: () =>
      received.filter(
        (message) =>
          "method" in message && message.method === "notifications/progress",
      ) as unknown as ReadonlyArray<{
        readonly params: Readonly<Record<string, unknown>> & {
          readonly progress: number;
        };
      }>,
    close: () => server.close(),
  };
}

describe("MCP progress notifications over a connected protocol server", () => {
  it("forwards progress with the request's token before the tool result", async () => {
    const connection = await connectRaw();

    await connection.send(
      toolCall(
        7,
        [
          { progress: 1, total: 4, message: "Rendering frame 1." },
          { waitMs: 150 },
          { progress: 4, total: 4 },
        ],
        { progressToken: "render-7" },
      ),
    );
    await connection.responseFor(7);

    expect(connection.received).toEqual([
      {
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: {
          progressToken: "render-7",
          progress: 1,
          total: 4,
          message: "Rendering frame 1.",
        },
      },
      {
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { progressToken: "render-7", progress: 4, total: 4 },
      },
      {
        jsonrpc: "2.0",
        id: 7,
        result: {
          content: [{ type: "text", text: '{"rendered":true}' }],
          structuredContent: { rendered: true },
        },
      },
    ]);
    await connection.close();
  });

  it("sends nothing when the request carries no usable progress token", async () => {
    const connection = await connectRaw();
    const steps = [{ progress: 1 }, { waitMs: 150 }, { progress: 2 }];

    await connection.send(toolCall("no-meta", steps));
    await connection.send(toolCall("empty-meta", steps, {}));
    await connection.send(
      toolCall("long", steps, { progressToken: "t".repeat(257) }),
    );
    await Promise.all(
      ["no-meta", "empty-meta", "long"].map((id) => connection.responseFor(id)),
    );

    expect(connection.progressNotifications()).toEqual([]);
    await connection.close();
  });

  it("echoes falsy and boundary-length progress tokens exactly", async () => {
    const connection = await connectRaw();
    const boundaryToken = "t".repeat(256);

    await connection.send(toolCall(0, [{ progress: 1 }], { progressToken: 0 }));
    await connection.send(
      toolCall("", [{ progress: 2 }], { progressToken: "" }),
    );
    await connection.send(
      toolCall("boundary", [{ progress: 3 }], {
        progressToken: boundaryToken,
      }),
    );
    await Promise.all(
      [0, "", "boundary"].map((id) => connection.responseFor(id)),
    );

    expect(
      connection
        .progressNotifications()
        .map((message) => [
          message.params.progressToken,
          message.params.progress,
        ]),
    ).toEqual(
      expect.arrayContaining([
        [0, 1],
        ["", 2],
        [boundaryToken, 3],
      ]),
    );
    expect(connection.progressNotifications()).toHaveLength(3);
    await connection.close();
  });

  it("coalesces bursts to the latest report at most once per interval", async () => {
    const connection = await connectRaw();

    await connection.send(
      toolCall(
        "burst",
        [{ progress: 1 }, { progress: 2 }, { progress: 3 }, { waitMs: 300 }],
        { progressToken: "burst" },
      ),
    );
    await connection.responseFor("burst");

    expect(
      connection
        .progressNotifications()
        .map((message) => message.params.progress),
    ).toEqual([1, 3]);
    await connection.close();
  });

  it("drops a coalesced report once the tool call settles", async () => {
    const connection = await connectRaw();

    await connection.send(
      toolCall("settled", [{ progress: 1 }, { progress: 2 }], {
        progressToken: "settled",
      }),
    );
    await connection.responseFor("settled");
    await sleep(200);

    expect(
      connection
        .progressNotifications()
        .map((message) => message.params.progress),
    ).toEqual([1]);
    await connection.close();
  });

  it("does not let a failed notification change the tool result", async () => {
    const engine = createScriptEngine();
    const server = createMcpServer(engine, {
      principal: null,
      source: "mcp-stdio",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const send = serverTransport.send.bind(serverTransport);
    serverTransport.send = (message, options) =>
      "method" in message && message.method === "notifications/progress"
        ? Promise.reject(new Error("progress pipe closed"))
        : send(message, options);
    const received: JSONRPCMessage[] = [];
    clientTransport.onmessage = (message) => {
      received.push(message);
    };
    await server.connect(serverTransport);
    await clientTransport.start();

    await clientTransport.send(
      toolCall("failing-pipe", [{ progress: 1 }], {
        progressToken: "failing-pipe",
      }),
    );
    await vi.waitFor(() => expect(received).toHaveLength(1));

    expect(received[0]).toMatchObject({
      id: "failing-pipe",
      result: { structuredContent: { rendered: true } },
    });
    await server.close();
  });

  it("delivers progress to the official client's progress callback", async () => {
    const engine = createScriptEngine();
    const server = createMcpServer(engine, {
      principal: null,
      source: "mcp-stdio",
    });
    const client = new Client(
      { name: "progress-test", version: "0.0.0-test" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    openClients.push(client);
    const progress: Progress[] = [];

    const result = await client.callTool(
      {
        name: "media_render",
        arguments: { steps: [{ progress: 1, total: 2, message: "Halfway." }] },
      },
      undefined,
      { onprogress: (update) => void progress.push(update) },
    );

    expect(result).toMatchObject({ structuredContent: { rendered: true } });
    expect(progress).toEqual([{ progress: 1, total: 2, message: "Halfway." }]);
  });
});

async function startHttp(engine = createScriptEngine()) {
  const server = await serveMcpHttp(engine, {
    port: 0,
    auth: {
      mode: "required",
      authenticate: (request) =>
        request.headers.get("authorization") === "Bearer progress"
          ? { id: "user:progress" }
          : null,
    },
  });
  openServers.push(server);
  return server;
}

function httpEndpoint(server: McpHttpServerHandle): string {
  const address = server.address();
  return `http://${address.host}:${address.port}/mcp`;
}

function postToolCall(
  server: McpHttpServerHandle,
  message: JSONRPCMessage,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(httpEndpoint(server), {
    method: "POST",
    headers: {
      authorization: "Bearer progress",
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify(message),
    ...(signal === undefined ? {} : { signal }),
  });
}

function parseServerSentEvents(text: string): unknown[] {
  return text.split("\n\n").flatMap((event) =>
    event
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)) as unknown),
  );
}

describe("MCP progress notifications over stateless HTTP", () => {
  it("answers a progress-token tool call with a request-scoped SSE stream", async () => {
    const server = await startHttp();

    const response = await postToolCall(
      server,
      toolCall(0, [{ progress: 1, total: 2, message: "Halfway." }], {
        progressToken: "http-0",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("mcp-session-id")).toBeNull();
    expect(parseServerSentEvents(await response.text())).toEqual([
      {
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: {
          progressToken: "http-0",
          progress: 1,
          total: 2,
          message: "Halfway.",
        },
      },
      {
        jsonrpc: "2.0",
        id: 0,
        result: {
          content: [{ type: "text", text: '{"rendered":true}' }],
          structuredContent: { rendered: true },
        },
      },
    ]);
  });

  it("keeps the JSON response when no usable progress token is present", async () => {
    const server = await startHttp();

    for (const meta of [
      undefined,
      {},
      { progressToken: "t".repeat(257) },
    ] as const) {
      const response = await postToolCall(
        server,
        toolCall("json", [{ progress: 1 }], meta),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(await response.json()).toMatchObject({
        id: "json",
        result: { structuredContent: { rendered: true } },
      });
    }
  });

  it("streams each notification before the tool call completes", async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = await startHttp(
      createScriptEngine({ beforeReturn: () => released }),
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(httpEndpoint(server)),
      { requestInit: { headers: { authorization: "Bearer progress" } } },
    );
    const client = new Client(
      { name: "http-progress-test", version: "0.0.0-test" },
      { capabilities: {} },
    );
    await client.connect(transport as unknown as Transport);
    openClients.push(client);
    const progress: Progress[] = [];

    const result = await client.callTool(
      {
        name: "media_render",
        arguments: { steps: [{ progress: 1, message: "Started." }] },
      },
      undefined,
      {
        onprogress(update) {
          progress.push(update);
          release();
        },
      },
    );

    expect(progress).toEqual([{ progress: 1, message: "Started." }]);
    expect(result).toMatchObject({ structuredContent: { rendered: true } });
  });

  it("aborts the capability when the client disconnects from the stream", async () => {
    let aborted!: () => void;
    const didAbort = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    const server = await startHttp(
      createScriptEngine({
        beforeReturn: () => new Promise(() => undefined),
        onAbort: () => aborted(),
      }),
    );
    const controller = new AbortController();
    const response = await postToolCall(
      server,
      toolCall("disconnect", [{ progress: 1 }], {
        progressToken: "disconnect",
      }),
      controller.signal,
    );
    const reader = response.body?.getReader();
    const first = await reader?.read();

    expect(new TextDecoder().decode(first?.value)).toContain(
      '"method":"notifications/progress"',
    );
    controller.abort();
    await expect(didAbort).resolves.toBeUndefined();
  });

  it("closes the server while a progress stream is open", async () => {
    let aborted!: () => void;
    const didAbort = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    const server = await serveMcpHttp(
      createScriptEngine({
        beforeReturn: () => new Promise(() => undefined),
        onAbort: () => aborted(),
      }),
      { port: 0, auth: { mode: "dangerously-disabled-for-development" } },
    );
    const response = await fetch(httpEndpoint(server), {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify(
        toolCall("closing", [{ progress: 1 }], { progressToken: "closing" }),
      ),
    });
    const reader = response.body?.getReader();
    await reader?.read();

    await expect(server.close()).resolves.toBeUndefined();
    await expect(didAbort).resolves.toBeUndefined();
    await reader?.cancel().catch(() => undefined);
  });
});
