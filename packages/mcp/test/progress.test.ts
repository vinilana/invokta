import { ServerResponse } from "node:http";
import { createConnection } from "node:net";

import { createEngine, defineCapability } from "@invokta/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  JSONRPCMessage,
  Progress,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { type McpHttpServerHandle, serveMcpHttp } from "../src/index.js";
import {
  createProgressForwarder,
  MIN_PROGRESS_NOTIFICATION_INTERVAL_MS,
} from "../src/progress.js";
import { createMcpServer } from "../src/protocol-server.js";
import { preserveFalsyRequestIds } from "../src/request-id-transport.js";
import { createMcpHttpHandler } from "../src/web.js";

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
        input: z.object({
          steps: z.array(stepSchema).max(100),
          fail: z.boolean().optional(),
        }),
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
          if (input.fail === true) throw new Error("private render failure");
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
  fail?: boolean,
): JSONRPCMessage {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: "media_render",
      arguments: { steps, ...(fail === undefined ? {} : { fail }) },
      ...(meta === undefined ? {} : { _meta: meta }),
    },
  } as JSONRPCMessage;
}

function isProgressNotification(message: JSONRPCMessage): boolean {
  return "method" in message && message.method === "notifications/progress";
}

async function connectRaw(
  engine = createScriptEngine(),
  options: {
    readonly canSendProgress?: () => boolean;
    /** Never settles progress writes, like a stdout pipe nobody drains. */
    readonly stallProgressWrites?: boolean;
  } = {},
) {
  const server = createMcpServer(engine, {
    principal: null,
    source: "mcp-stdio",
    ...(options.canSendProgress === undefined
      ? {}
      : { canSendProgress: options.canSendProgress }),
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  let progressWrites = 0;
  const sendToClient = serverTransport.send.bind(serverTransport);
  serverTransport.send = (message, sendOptions) => {
    if (!isProgressNotification(message)) {
      return sendToClient(message, sendOptions);
    }
    progressWrites += 1;
    if (options.stallProgressWrites !== true) {
      return sendToClient(message, sendOptions);
    }
    return new Promise<void>(() => undefined);
  };
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
    progressWrites: () => progressWrites,
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

  it("delivers a coalesced report just before a successful result", async () => {
    const connection = await connectRaw();

    await connection.send(
      toolCall(
        "settled",
        [{ progress: 1, total: 3 }, { progress: 2 }, { progress: 3, total: 3 }],
        { progressToken: "settled" },
      ),
    );
    await connection.responseFor("settled");
    await sleep(200);

    expect(
      connection.received.map((message) =>
        isProgressNotification(message)
          ? (message as unknown as { params: { progress: number } }).params
              .progress
          : "result",
      ),
    ).toEqual([1, 3, "result"]);
    await connection.close();
  });

  it("drops a coalesced report when the tool call fails", async () => {
    const connection = await connectRaw();

    await connection.send(
      toolCall(
        "failed",
        [{ progress: 1 }, { progress: 2 }],
        { progressToken: "failed" },
        true,
      ),
    );
    await vi.waitFor(() =>
      expect(
        connection.received.some(
          (message) => "id" in message && message.id === "failed",
        ),
      ).toBe(true),
    );
    await sleep(200);

    expect(
      connection
        .progressNotifications()
        .map((message) => message.params.progress),
    ).toEqual([1]);
    expect(connection.received.at(-1)).toMatchObject({
      id: "failed",
      result: { isError: true },
    });
    await connection.close();
  });

  it("holds only the latest report while a stalled reader leaves a notification unwritten", async () => {
    const connection = await connectRaw(createScriptEngine(), {
      stallProgressWrites: true,
    });
    const steps = Array.from({ length: 40 }, (_, index) => [
      { progress: index + 1, message: "m".repeat(1_024) },
      { waitMs: 10 },
    ]).flat();

    await connection.send(
      toolCall("stalled", steps, { progressToken: "t".repeat(256) }),
    );
    await connection.responseFor("stalled");

    // One write stays pending for the whole call; the latest report is held
    // and delivered once before the result instead of queueing 40 writes.
    expect(connection.progressWrites()).toBe(2);
    await connection.close();
  });

  it("holds only the latest report while the downstream gate is closed", async () => {
    let open = false;
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const connection = await connectRaw(
      createScriptEngine({ beforeReturn: () => released }),
      { canSendProgress: () => open },
    );

    await connection.send(
      toolCall(
        "gated",
        Array.from({ length: 10 }, (_, index) => [
          { progress: index + 1 },
          { waitMs: 20 },
        ]).flat(),
        { progressToken: "gated" },
      ),
    );
    await sleep(350);
    expect(connection.progressWrites()).toBe(0);

    open = true;
    await vi.waitFor(() => expect(connection.progressWrites()).toBe(1));
    expect(
      connection
        .progressNotifications()
        .map((message) => message.params.progress),
    ).toEqual([10]);
    release();
    await connection.responseFor("gated");
    expect(connection.progressWrites()).toBe(1);
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

describe("the MCP progress forwarder", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function recordingSend() {
    const sent: number[] = [];
    const pending: Array<() => void> = [];
    return {
      sent,
      settleAll: () => {
        for (const settle of pending.splice(0)) settle();
      },
      send: (params: { readonly progress: number }) => {
        sent.push(params.progress);
        return new Promise<void>((resolve) => {
          pending.push(resolve);
        });
      },
    };
  }

  it("never has more than one notification in flight", async () => {
    vi.useFakeTimers();
    const downstream = recordingSend();
    const forwarder = createProgressForwarder("token", downstream.send);

    for (let progress = 1; progress <= 50; progress += 1) {
      forwarder.report({ progress });
      await vi.advanceTimersByTimeAsync(MIN_PROGRESS_NOTIFICATION_INTERVAL_MS);
    }
    expect(downstream.sent).toEqual([1]);

    downstream.settleAll();
    await vi.advanceTimersByTimeAsync(MIN_PROGRESS_NOTIFICATION_INTERVAL_MS);
    expect(downstream.sent).toEqual([1, 50]);
    forwarder.close();
  });

  it("treats a throwing gate as having no capacity", async () => {
    vi.useFakeTimers();
    const downstream = recordingSend();
    const forwarder = createProgressForwarder("token", downstream.send, () => {
      throw new Error("gate unavailable");
    });

    forwarder.report({ progress: 1 });
    await vi.advanceTimersByTimeAsync(
      10 * MIN_PROGRESS_NOTIFICATION_INTERVAL_MS,
    );

    expect(downstream.sent).toEqual([]);
    forwarder.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("delivers the held report on finish and nothing after it", async () => {
    vi.useFakeTimers();
    const downstream = recordingSend();
    const forwarder = createProgressForwarder("token", downstream.send);

    forwarder.report({ progress: 1 });
    forwarder.report({ progress: 2 });
    forwarder.finish();
    forwarder.report({ progress: 3 });
    forwarder.finish();
    await vi.advanceTimersByTimeAsync(
      10 * MIN_PROGRESS_NOTIFICATION_INTERVAL_MS,
    );

    expect(downstream.sent).toEqual([1, 2]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops the held report on close", async () => {
    vi.useFakeTimers();
    const downstream = recordingSend();
    const forwarder = createProgressForwarder("token", downstream.send);

    forwarder.report({ progress: 1 });
    forwarder.report({ progress: 2 });
    forwarder.close();
    forwarder.finish();
    await vi.advanceTimersByTimeAsync(
      10 * MIN_PROGRESS_NOTIFICATION_INTERVAL_MS,
    );

    expect(downstream.sent).toEqual([1]);
    expect(vi.getTimerCount()).toBe(0);
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

/** Reports every 20 ms for about one second with large, escaped payloads. */
function floodSteps(): ReadonlyArray<Step> {
  return Array.from({ length: 50 }, (_, index) => [
    { progress: index + 1, message: "\u0001".repeat(1_024) },
    { waitMs: 20 },
  ]).flat();
}

const floodToken = "\u0001".repeat(256);

function countProgressSends() {
  const send = vi.spyOn(
    WebStandardStreamableHTTPServerTransport.prototype,
    "send",
  );
  return {
    count: () =>
      send.mock.calls.filter(([message]) => isProgressNotification(message))
        .length,
    restore: () => send.mockRestore(),
  };
}

function signalWhenFinished() {
  let finished!: () => void;
  const didFinish = new Promise<void>((resolve) => {
    finished = resolve;
  });
  return { didFinish, beforeReturn: async () => finished() };
}

describe("MCP progress notifications through the Web handler", () => {
  function webRequest(message: JSONRPCMessage): Request {
    return new Request("http://127.0.0.1/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify(message),
    });
  }

  it("answers a progress-token call with an SSE stream without hop-by-hop headers", async () => {
    const handle = createMcpHttpHandler(createScriptEngine(), {
      auth: { mode: "dangerously-disabled-for-development" },
    });

    const response = await handle(
      webRequest(toolCall(0, [{ progress: 1 }], { progressToken: "web-0" })),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.has("connection")).toBe(false);
    expect(response.headers.has("keep-alive")).toBe(false);
    expect(response.headers.has("transfer-encoding")).toBe(false);
    expect(parseServerSentEvents(await response.text())).toEqual([
      {
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { progressToken: "web-0", progress: 1 },
      },
      expect.objectContaining({ id: 0, result: expect.any(Object) }),
    ]);
  });

  it("holds at most one report while the reader of the stream is stalled", async () => {
    const sends = countProgressSends();
    const run = signalWhenFinished();
    try {
      const handle = createMcpHttpHandler(createScriptEngine(run), {
        auth: { mode: "dangerously-disabled-for-development" },
      });
      const response = await handle(
        webRequest(
          toolCall("web-stalled", floodSteps(), { progressToken: floodToken }),
        ),
      );
      const reader = response.body?.getReader();
      const first = await reader?.read();
      expect(new TextDecoder().decode(first?.value)).toContain(
        "notifications/progress",
      );

      // Without a bound, about ten notifications per second would queue.
      await run.didFinish;
      await sleep(50);
      expect(sends.count()).toBeLessThanOrEqual(3);

      let text = new TextDecoder().decode(first?.value);
      for (;;) {
        const chunk = await reader?.read();
        if (chunk === undefined || chunk.done) break;
        text += new TextDecoder().decode(chunk.value);
      }
      const events = parseServerSentEvents(text);
      expect(events.length).toBeLessThanOrEqual(4);
      expect(events.at(-1)).toMatchObject({
        id: "web-stalled",
        result: { structuredContent: { rendered: true } },
      });
    } finally {
      sends.restore();
    }
  });

  it("aborts the capability when the response stream is cancelled", async () => {
    let aborted!: () => void;
    const didAbort = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    const handle = createMcpHttpHandler(
      createScriptEngine({
        beforeReturn: () => new Promise(() => undefined),
        onAbort: () => aborted(),
      }),
      { auth: { mode: "dangerously-disabled-for-development" } },
    );

    const response = await handle(
      webRequest(
        toolCall("web-cancel", [{ progress: 1 }], {
          progressToken: "web-cancel",
        }),
      ),
    );
    const reader = response.body?.getReader();
    await reader?.read();
    await reader?.cancel();

    await expect(didAbort).resolves.toBeUndefined();
  });
});

describe("MCP progress notifications through the Node.js adapter", () => {
  it("stops relaying while the socket cannot take more data", async () => {
    const sends = countProgressSends();
    const realWrite = ServerResponse.prototype.write;
    // Every chunk is still written, but the response reports a full buffer
    // and never drains, as a client that stopped reading would cause.
    const write = vi
      .spyOn(ServerResponse.prototype, "write")
      .mockImplementation(function (
        this: ServerResponse,
        ...args: Parameters<ServerResponse["write"]>
      ) {
        Reflect.apply(realWrite, this, args);
        return false;
      });
    const run = signalWhenFinished();
    const controller = new AbortController();
    try {
      const server = await startHttp(createScriptEngine(run));
      const response = await postToolCall(
        server,
        toolCall("node-stalled", floodSteps(), { progressToken: floodToken }),
        controller.signal,
      );
      const reader = response.body?.getReader();
      await reader?.read();

      await run.didFinish;
      await sleep(50);
      expect(sends.count()).toBeLessThanOrEqual(3);
      expect(write.mock.calls.length).toBeLessThanOrEqual(2);
    } finally {
      controller.abort();
      write.mockRestore();
      sends.restore();
    }
  });

  it("closes the connection after the stream when the request asks for it", async () => {
    const server = await startHttp();
    const address = server.address();
    const body = JSON.stringify(
      toolCall("close", [{ progress: 1 }], { progressToken: "close" }),
    );
    const socket = createConnection({
      host: address.host,
      port: address.port,
    });
    let received = "";
    let endedAt: number | undefined;
    const closed = new Promise<number>((resolve) => {
      socket.once("close", () => resolve(performance.now()));
    });
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString("utf8");
      if (received.endsWith("0\r\n\r\n")) endedAt ??= performance.now();
    });
    socket.write(
      [
        "POST /mcp HTTP/1.1",
        `Host: ${address.host}:${String(address.port)}`,
        "Authorization: Bearer progress",
        "Accept: application/json, text/event-stream",
        "Content-Type: application/json",
        "Connection: close",
        `Content-Length: ${String(Buffer.byteLength(body))}`,
        "",
        body,
      ].join("\r\n"),
    );

    const closedAt = await closed;
    const head = received.slice(0, received.indexOf("\r\n\r\n")).toLowerCase();

    expect(head).toContain("content-type: text/event-stream");
    expect(head).toContain("connection: close");
    expect(head).not.toContain("keep-alive");
    expect(received).toContain('"id":"close"');
    expect(endedAt).toBeDefined();
    expect(closedAt - (endedAt ?? closedAt)).toBeLessThan(1_000);
  });
});
