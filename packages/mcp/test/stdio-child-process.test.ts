import {
  type ChildProcessWithoutNullStreams,
  execFileSync,
  spawn,
} from "node:child_process";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { beforeAll, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const fixturePath = fileURLToPath(
  new URL("./fixtures/stdio-server.mjs", import.meta.url),
);
const lifecycleFixturePath = fileURLToPath(
  new URL("./fixtures/stdio-lifecycle-server.mjs", import.meta.url),
);

interface TextCapture {
  readonly value: () => string;
  readonly waitFor: (expected: string) => Promise<void>;
}

function captureText(stream: Readable): TextCapture {
  let value = "";
  const waiters = new Set<{
    readonly expected: string;
    readonly resolve: () => void;
  }>();
  stream.on("data", (chunk: Buffer | string) => {
    value += chunk.toString();
    for (const waiter of waiters) {
      if (value.includes(waiter.expected)) {
        waiters.delete(waiter);
        waiter.resolve();
      }
    }
  });
  return {
    value: () => value,
    async waitFor(expected) {
      if (value.includes(expected)) return;
      await new Promise<void>((resolve, reject) => {
        let timer: NodeJS.Timeout;
        const waiter = {
          expected,
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
        };
        waiters.add(waiter);
        timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(
            new Error(`Timed out waiting for ${JSON.stringify(expected)}.`),
          );
        }, 2_000);
        timer.unref();
      });
    },
  };
}

function spawnLifecycleServer(
  mode?: "backpressure" | "delayed-epipe" | "pre-ended",
): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, [lifecycleFixturePath], {
    cwd: repositoryRoot,
    env: { ...process.env, STDIO_LIFECYCLE_MODE: mode },
    stdio: "pipe",
  });
  child.stdin.on("error", () => undefined);
  return child;
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error("The stdio server did not exit after its channel closed."),
      );
    }, 5_000);
    timer.unref();
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function sendMessage(
  child: ChildProcessWithoutNullStreams,
  message: Readonly<Record<string, unknown>>,
): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

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
    { cwd: repositoryRoot, stdio: "pipe" },
  );
});

it("serves handshake, tools/list, and tools/call over protocol-only stdio", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fixturePath],
    cwd: repositoryRoot,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });
  const client = new Client(
    { name: "stdio-child-process-test", version: "0.0.0-test" },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);
    expect(client.getServerVersion()).toEqual({
      name: "stdio-smoke-engine",
      version: "0.1.0",
    });
    await expect(client.listTools()).resolves.toMatchObject({
      tools: [
        {
          name: "example.inspect-context",
          description: "Returns the stdio execution boundary context.",
        },
      ],
    });
    await expect(
      client.callTool({
        name: "example.inspect-context",
        arguments: { value: "wire-ok" },
      }),
    ).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            value: "wire-ok",
            source: "mcp-stdio",
            anonymous: true,
          }),
        },
      ],
      structuredContent: {
        value: "wire-ok",
        source: "mcp-stdio",
        anonymous: true,
      },
    });
  } finally {
    await client.close();
  }

  expect(stderr).toBe("");
});

it("closes on stdin EOF, cancels active work, and exits cleanly", async () => {
  const child = spawnLifecycleServer();
  const stdout = captureText(child.stdout);
  const stderr = captureText(child.stderr);
  const exited = waitForExit(child);

  sendMessage(child, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "stdio-eof-test", version: "0.0.0-test" },
    },
  });
  await stdout.waitFor('"id":1');
  sendMessage(child, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  sendMessage(child, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "example.wait", arguments: {} },
  });
  await stderr.waitFor("started\n");

  child.stdin.end();

  await expect(exited).resolves.toEqual({ code: 0, signal: null });
  expect(stderr.value()).toBe("started\ncancelled\nlisteners-clean\n");
  for (const line of stdout.value().trim().split("\n")) {
    expect(() => JSON.parse(line)).not.toThrow();
  }
});

it("contains a broken stdout pipe and exits without an uncaught stack", async () => {
  const child = spawnLifecycleServer();
  const stderr = captureText(child.stderr);
  const exited = waitForExit(child);
  child.stdout.destroy();

  sendMessage(child, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "stdio-epipe-test", version: "0.0.0-test" },
    },
  });

  await expect(exited).resolves.toEqual({ code: 0, signal: null });
  expect(stderr.value()).toBe("listeners-clean\n");
});

it("contains a delayed EPIPE after stdin closes during an active write", async () => {
  const child = spawnLifecycleServer("delayed-epipe");
  const stderr = captureText(child.stderr);
  const exited = waitForExit(child);

  sendMessage(child, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "stdio-delayed-epipe-test", version: "0.0.0-test" },
    },
  });
  await stderr.waitFor("write-started\n");
  child.stdin.end();

  await expect(exited).resolves.toEqual({ code: 0, signal: null });
  expect(stderr.value()).toBe("write-started\nlisteners-clean\n");
});

it("drops a backpressured response when stdin closes and exits cleanly", async () => {
  const child = spawnLifecycleServer("backpressure");
  const stderr = captureText(child.stderr);
  const exited = waitForExit(child);

  sendMessage(child, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "stdio-backpressure-test", version: "0.0.0-test" },
    },
  });
  sendMessage(child, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  sendMessage(child, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "example.large", arguments: {} },
  });
  await stderr.waitFor("large-write-started\n");
  child.stdin.end();

  await expect(exited).resolves.toEqual({ code: 0, signal: null });
  expect(stderr.value()).toBe(
    "large-result\nlarge-write-started\nlisteners-clean\n",
  );
});

it("closes when stdin had already ended before the adapter starts", async () => {
  const child = spawnLifecycleServer("pre-ended");
  const stderr = captureText(child.stderr);
  const exited = waitForExit(child);
  child.stdin.end();

  await expect(exited).resolves.toEqual({ code: 0, signal: null });
  expect(stderr.value()).toBe("listeners-clean\n");
});

it("round trips and cancels concurrent request IDs including falsy IDs", async () => {
  const child = spawnLifecycleServer();
  const stdout = captureText(child.stdout);
  const stderr = captureText(child.stderr);
  const exited = waitForExit(child);

  try {
    sendMessage(child, {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: {
          name: "stdio-falsy-cancellation-test",
          version: "0.0.0-test",
        },
      },
    });
    await stdout.waitFor('"id":0');
    sendMessage(child, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    sendMessage(child, {
      jsonrpc: "2.0",
      id: "",
      method: "tools/list",
    });
    await stdout.waitFor('"id":""');

    const requests = [
      { id: 0, label: "numeric-zero" },
      { id: "", label: "empty-string" },
      { id: 1, label: "numeric-control" },
      { id: "control", label: "string-control" },
    ] as const;
    for (const { id, label } of requests) {
      sendMessage(child, {
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name: "example.concurrent-wait",
          arguments: { label },
        },
      });
    }
    for (const { label } of requests) {
      await stderr.waitFor(`started:${label}\n`);
    }
    for (const { id } of requests) {
      sendMessage(child, {
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: id, reason: "test cancellation" },
      });
    }
    for (const { label } of requests) {
      await stderr.waitFor(`cancelled:${label}\n`);
    }
  } finally {
    child.stdin.end();
  }

  await expect(exited).resolves.toEqual({ code: 0, signal: null });
  expect(stderr.value()).toBe(
    [
      "started:numeric-zero",
      "started:empty-string",
      "started:numeric-control",
      "started:string-control",
      "cancelled:numeric-zero",
      "cancelled:empty-string",
      "cancelled:numeric-control",
      "cancelled:string-control",
      "listeners-clean",
      "",
    ].join("\n"),
  );
  expect(
    stdout
      .value()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
  ).toEqual([
    expect.objectContaining({ jsonrpc: "2.0", id: 0 }),
    expect.objectContaining({ jsonrpc: "2.0", id: "" }),
  ]);
});
