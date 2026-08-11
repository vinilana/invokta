import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  type ObservabilityStub,
  startObservabilityStub,
} from "./observability-stub.js";

const exampleRoot = fileURLToPath(new URL("..", import.meta.url));
const capabilityId = "observability.collect-incident-context";
const toolName = "observability_collect-incident-context";
const input = {
  service: "checkout-api",
  from: "2026-07-28T12:00:00.000Z",
  to: "2026-07-28T13:00:00.000Z",
  limit: 2,
} as const;

let stub: ObservabilityStub;

beforeAll(() => {
  const build = spawnSync(
    process.execPath,
    ["../../node_modules/typescript/bin/tsc", "-b", "--pretty", "false"],
    { cwd: exampleRoot, encoding: "utf8" },
  );
  if (build.status !== 0) {
    throw new Error(`Example build failed:\n${build.stdout}${build.stderr}`);
  }
});

beforeEach(async () => {
  stub = await startObservabilityStub();
});

afterEach(async () => {
  await stub.close();
});

function providerEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SENTRY_AUTH_TOKEN: "test-sentry-token",
    SENTRY_ORG: "acme",
    SENTRY_BASE_URL: stub.baseUrl,
    DD_API_KEY: "test-datadog-api-key",
    DD_APP_KEY: "test-datadog-application-key",
    DD_BASE_URL: stub.baseUrl,
    NEW_RELIC_USER_KEY: "test-new-relic-user-key",
    NEW_RELIC_ACCOUNT_ID: "123456",
    NEW_RELIC_GRAPHQL_URL: `${stub.baseUrl}/graphql`,
  };
}

interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(
  entrypoint: string,
  args: readonly string[] = [],
  environment: NodeJS.ProcessEnv = providerEnvironment(),
): Promise<CommandResult> {
  const child = spawn(process.execPath, [`dist/${entrypoint}.js`, ...args], {
    cwd: exampleRoot,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer | string) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });
  const [status] = (await once(child, "exit")) as [number | null];
  return { status, stdout, stderr };
}

async function stopProcess(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill();
  await exited;
}

function expectedContext() {
  return {
    service: input.service,
    from: input.from,
    to: input.to,
    issues: [
      {
        id: "SENTRY-1",
        title: "Payment confirmation failed",
        status: "unresolved",
        project: "checkout-api",
        lastSeen: "2026-07-28T12:45:00.000Z",
        eventCount: 42,
        url: "https://sentry.example/issues/SENTRY-1",
      },
    ],
    logs: [
      {
        id: "DD-1",
        timestamp: "2026-07-28T12:40:00.000Z",
        service: "checkout-api",
        severity: "error",
        message: "Payment confirmation failed",
      },
    ],
    telemetry: {
      transactionCount: 125,
      errorRate: 2.5,
      averageDurationMs: 420,
    },
  };
}

describe("observability engine entrypoints", () => {
  it("collects incident context through the direct entrypoint with result-only stdout", async () => {
    const result = await run("direct", [input.service, input.from, input.to]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual(expectedContext());
  });

  it("publishes and runs the same capability through the CLI", async () => {
    const listed = await run("cli", ["list"]);
    expect(listed.status).toBe(0);
    expect(listed.stderr).toBe("");
    expect(JSON.parse(listed.stdout)).toMatchObject([{ id: capabilityId }]);

    const invoked = await run("cli", [
      "run",
      capabilityId,
      "--input",
      JSON.stringify(input),
    ]);
    expect(invoked.status).toBe(0);
    expect(invoked.stderr).toBe("");
    expect(JSON.parse(invoked.stdout)).toEqual(expectedContext());
  });

  it("fails startup without all provider credentials", async () => {
    const result = await run("cli", ["list"], {
      ...providerEnvironment(),
      DD_APP_KEY: "",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: { code: "EXECUTION_FAILED" },
    });
  });

  it("serves the capability over protocol-only MCP stdio", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["dist/mcp-stdio.js"],
      cwd: exampleRoot,
      env: providerEnvironment() as Record<string, string>,
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    const client = new Client(
      { name: "observability-stdio-test", version: "0.0.0-test" },
      { capabilities: {} },
    );

    try {
      await client.connect(transport);
      await expect(client.listTools()).resolves.toMatchObject({
        tools: [{ name: toolName }],
      });
      await expect(
        client.callTool({ name: toolName, arguments: input }),
      ).resolves.toMatchObject({ structuredContent: expectedContext() });
    } finally {
      await client.close();
    }

    expect(stderr).toBe("");
  });

  it("serves authenticated stateless MCP HTTP without exposing credentials", async () => {
    const token = "test-only-observability-token";
    const child = spawn(process.execPath, ["dist/mcp-http.js"], {
      cwd: exampleRoot,
      env: {
        ...providerEnvironment(),
        OBSERVABILITY_ENGINE_BEARER_TOKEN: token,
        PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    let client: Client | undefined;

    try {
      const port = await vi.waitFor(
        () => {
          const match = stderr.match(/host 127\.0\.0\.1, port (\d+)/u);
          expect(match?.[1]).toBeDefined();
          return Number(match?.[1]);
        },
        { timeout: 5_000 },
      );
      const url = new URL(`http://127.0.0.1:${String(port)}/mcp`);
      const unauthenticated = await fetch(url, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "auth-boundary",
          method: "tools/call",
          params: { name: toolName, arguments: input },
        }),
      });
      expect(unauthenticated.status).toBe(401);
      await unauthenticated.arrayBuffer();

      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      });
      client = new Client(
        { name: "observability-http-test", version: "0.0.0-test" },
        { capabilities: {} },
      );
      await client.connect(transport as unknown as Transport);
      await expect(
        client.callTool({ name: toolName, arguments: input }),
      ).resolves.toMatchObject({ structuredContent: expectedContext() });
    } finally {
      await client?.close().catch(() => undefined);
      await stopProcess(child);
    }

    expect(stdout).toBe("");
    expect(stderr).not.toContain(token);
    expect(stderr).not.toContain("test-sentry-token");
    expect(stderr).not.toContain("test-datadog-api-key");
    expect(stderr).not.toContain("test-new-relic-user-key");
  });
});
