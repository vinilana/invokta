import type { McpClientConnection } from "@invokta/mcp";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  McpClientConnector,
  McpVerificationIo,
} from "../src/verify-mcp.js";
import { runMcpVerification } from "../src/verify-mcp.js";

const catalogByteLimit = 10_485_760;
const stdioTarget = {
  transport: "stdio",
  command: "descriptor-command-canary",
  args: ["descriptor-argument-canary"],
  env: { TARGET_TOKEN: "credential-value-canary" },
} as const;

interface Harness {
  readonly stdout: string[];
  readonly stderr: string[];
  readonly io: McpVerificationIo;
}

function createHarness(): Harness {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      writeStdout: (text) => {
        stdout.push(text);
      },
      writeStderr: (text) => {
        stderr.push(text);
      },
    },
  };
}

function createConnection(overrides: Record<string, unknown> = {}) {
  return {
    server: {
      name: "example-server",
      version: "1.0.0",
      protocolVersion: "2025-11-25",
      instructions: "server-instruction-canary",
      capabilities: { canary: "server-capability-canary" },
    },
    listTools: vi.fn(async () => ({ tools: [] })),
    callTool: vi.fn(async () => ({ response: {} })),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

function connectorFor(connection: ReturnType<typeof createConnection>) {
  return vi.fn(async () => connection) as unknown as McpClientConnector;
}

function encodedCatalogTool(totalCatalogBytes: number) {
  const emptyTool = {
    name: "catalog-boundary",
    inputSchema: { type: "object", marker: "" },
  };
  const baseBytes = Buffer.byteLength(JSON.stringify([emptyTool]), "utf8");
  expect(baseBytes).toBeLessThan(totalCatalogBytes);
  return {
    ...emptyTool,
    inputSchema: {
      ...emptyTool.inputSchema,
      marker: "x".repeat(totalCatalogBytes - baseBytes),
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("runMcpVerification", () => {
  it("initializes once, lists every page sequentially, never calls a tool, and closes before reporting success", async () => {
    const harness = createHarness();
    const cursors: (string | undefined)[] = [];
    let activeLists = 0;
    let maximumActiveLists = 0;
    const connection = createConnection({
      listTools: vi.fn(async (cursor?: string) => {
        cursors.push(cursor);
        activeLists += 1;
        maximumActiveLists = Math.max(maximumActiveLists, activeLists);
        await Promise.resolve();
        activeLists -= 1;
        if (cursor === undefined) {
          return {
            tools: [{ name: "first", inputSchema: { type: "object" } }],
            nextCursor: "",
          };
        }
        if (cursor === "") {
          return {
            tools: [{ name: "second", inputSchema: { type: "object" } }],
            nextCursor: "cursor-2",
          };
        }
        return {
          tools: [{ name: "third", inputSchema: { type: "object" } }],
        };
      }),
    });
    const connect = connectorFor(connection);

    const exitCode = await runMcpVerification({
      target: stdioTarget,
      io: harness.io,
      connect,
    });

    expect(exitCode).toBe(0);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith(
      stdioTarget,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(cursors).toEqual([undefined, "", "cursor-2"]);
    expect(maximumActiveLists).toBe(1);
    expect(connection.callTool).not.toHaveBeenCalled();
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(harness.stderr).toEqual([]);
    expect(harness.stdout).toEqual([
      '{"status":"ok","transport":"stdio","server":{"name":"example-server","version":"1.0.0","protocolVersion":"2025-11-25"},"pageCount":3,"toolCount":3}\n',
    ]);
    expect(harness.stdout.join("")).not.toContain("descriptor-command-canary");
    expect(harness.stdout.join("")).not.toContain("credential-value-canary");
    expect(harness.stdout.join("")).not.toContain("server-instruction-canary");
    expect(harness.stdout.join("")).not.toContain("server-capability-canary");
  });

  it("reports the selected HTTP transport without returning its descriptor", async () => {
    const harness = createHarness();
    const connection = createConnection();
    const connect = connectorFor(connection);
    const target = {
      transport: "http",
      url: "https://target-url-canary.example/mcp",
      authentication: { type: "bearer", token: "bearer-token-canary" },
    } as const;

    const exitCode = await runMcpVerification({
      target,
      io: harness.io,
      connect,
    });

    expect(exitCode).toBe(0);
    expect(harness.stdout.join("")).toContain('"transport":"http"');
    expect(harness.stdout.join("")).not.toContain("target-url-canary");
    expect(harness.stdout.join("")).not.toContain("bearer-token-canary");
  });

  it("accepts exactly 100 pages and 2,000 tools", async () => {
    const harness = createHarness();
    const tools = Array.from({ length: 20 }, (_, index) => ({
      name: `tool-${String(index)}`,
      inputSchema: { type: "object" },
    }));
    let page = 0;
    const connection = createConnection({
      listTools: vi.fn(async () => {
        page += 1;
        return {
          tools: tools.map((tool) => ({
            ...tool,
            name: `page-${String(page)}-${tool.name}`,
          })),
          ...(page === 100 ? {} : { nextCursor: `page-${String(page + 1)}` }),
        };
      }),
    });

    const exitCode = await runMcpVerification({
      target: stdioTarget,
      io: harness.io,
      connect: connectorFor(connection),
    });

    expect(exitCode).toBe(0);
    expect(connection.listTools).toHaveBeenCalledTimes(100);
    expect(harness.stdout.join("")).toContain('"pageCount":100');
    expect(harness.stdout.join("")).toContain('"toolCount":2000');
  });

  it.each([
    {
      name: "the first page beyond 100",
      makePage: (page: number) => ({
        tools: [],
        ...(page === 101 ? {} : { nextCursor: `page-${String(page + 1)}` }),
      }),
      expectedCalls: 100,
    },
    {
      name: "the first tool beyond 2,000",
      makePage: () => ({
        tools: Array.from({ length: 2_001 }, (_, index) => ({
          name: `tool-${String(index)}`,
          inputSchema: { type: "object" },
        })),
      }),
      expectedCalls: 1,
    },
  ])("rejects $name and closes the connection", async (fixture) => {
    const harness = createHarness();
    let page = 0;
    const connection = createConnection({
      listTools: vi.fn(async () => {
        page += 1;
        return fixture.makePage(page);
      }),
    });

    const exitCode = await runMcpVerification({
      target: stdioTarget,
      io: harness.io,
      connect: connectorFor(connection),
    });

    expect(exitCode).toBe(1);
    expect(connection.listTools).toHaveBeenCalledTimes(fixture.expectedCalls);
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(harness.stdout).toEqual([]);
    expect(harness.stderr).toEqual([
      "invokta-devtools verify: LIMIT_EXCEEDED: The MCP verification limit was exceeded.\n",
    ]);
  });

  it("rejects an empty advertised tool name", async () => {
    const harness = createHarness();
    const connection = createConnection({
      listTools: vi.fn(async () => ({
        tools: [{ name: "", inputSchema: { type: "object" } }],
      })),
    });

    const exitCode = await runMcpVerification({
      target: stdioTarget,
      io: harness.io,
      connect: connectorFor(connection),
    });

    expect(exitCode).toBe(1);
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(harness.stderr).toEqual([
      "invokta-devtools verify: PROTOCOL_ERROR: The MCP target returned an invalid protocol response.\n",
    ]);
  });

  it("accepts a catalog whose compact UTF-8 encoding is exactly 10 MiB", async () => {
    const harness = createHarness();
    const connection = createConnection({
      listTools: vi.fn(async () => ({
        tools: [encodedCatalogTool(catalogByteLimit)],
      })),
    });

    const exitCode = await runMcpVerification({
      target: stdioTarget,
      io: harness.io,
      connect: connectorFor(connection),
    });

    expect(exitCode).toBe(0);
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it("rejects the first catalog byte beyond 10 MiB", async () => {
    const harness = createHarness();
    const connection = createConnection({
      listTools: vi.fn(async () => ({
        tools: [encodedCatalogTool(catalogByteLimit + 1)],
      })),
    });

    const exitCode = await runMcpVerification({
      target: stdioTarget,
      io: harness.io,
      connect: connectorFor(connection),
    });

    expect(exitCode).toBe(1);
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(harness.stderr).toEqual([
      "invokta-devtools verify: LIMIT_EXCEEDED: The MCP verification limit was exceeded.\n",
    ]);
  });

  it.each([
    {
      name: "a repeated pagination cursor",
      pages: [
        { tools: [], nextCursor: "repeat" },
        { tools: [], nextCursor: "repeat" },
      ],
    },
    {
      name: "a duplicate tool name",
      pages: [
        {
          tools: [
            { name: "duplicate", inputSchema: {} },
            { name: "duplicate", inputSchema: {} },
          ],
        },
      ],
    },
  ])("rejects $name as a protocol error", async ({ pages }) => {
    const harness = createHarness();
    let page = 0;
    const connection = createConnection({
      listTools: vi.fn(async () => pages[page++] as (typeof pages)[number]),
    });

    const exitCode = await runMcpVerification({
      target: stdioTarget,
      io: harness.io,
      connect: connectorFor(connection),
    });

    expect(exitCode).toBe(1);
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(harness.stderr).toEqual([
      "invokta-devtools verify: PROTOCOL_ERROR: The MCP target returned an invalid protocol response.\n",
    ]);
  });

  it("sanitizes connector failures and classifies invalid targets as usage", async () => {
    const harness = createHarness();
    const connect = vi.fn(async () => {
      throw {
        code: "INVALID_TARGET",
        message:
          "descriptor-command-canary credential-value-canary target-url-canary",
        descriptor: stdioTarget,
      };
    }) as unknown as McpClientConnector;

    const exitCode = await runMcpVerification({
      target: stdioTarget,
      io: harness.io,
      connect,
    });

    expect(exitCode).toBe(2);
    expect(harness.stdout).toEqual([]);
    expect(harness.stderr).toEqual([
      "invokta-devtools verify: INVALID_TARGET: The MCP target is invalid.\n",
    ]);
  });

  it("sanitizes protocol failures, closes once, and ignores a secondary cleanup failure", async () => {
    const harness = createHarness();
    const connection = createConnection({
      listTools: vi.fn(async () => {
        throw {
          code: "AUTHENTICATION_FAILED",
          message: "bearer-token-canary target-url-canary",
        };
      }),
      close: vi.fn(async () => {
        throw new Error("credential-value-canary");
      }),
    });

    const exitCode = await runMcpVerification({
      target: stdioTarget,
      io: harness.io,
      connect: connectorFor(connection),
    });

    expect(exitCode).toBe(1);
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(harness.stdout).toEqual([]);
    expect(harness.stderr).toEqual([
      "invokta-devtools verify: AUTHENTICATION_FAILED: The MCP target rejected authentication.\n",
    ]);
  });

  it("turns cleanup failure after successful validation into a safe connection failure", async () => {
    const harness = createHarness();
    const connection = createConnection({
      close: vi.fn(async () => {
        throw new Error("credential-value-canary");
      }),
    });

    const exitCode = await runMcpVerification({
      target: stdioTarget,
      io: harness.io,
      connect: connectorFor(connection),
    });

    expect(exitCode).toBe(1);
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(harness.stdout).toEqual([]);
    expect(harness.stderr).toEqual([
      "invokta-devtools verify: CONNECTION_FAILED: The MCP connection failed.\n",
    ]);
  });

  it("fails unresolved initialization at exactly 15 seconds", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    let initializationSignal: AbortSignal | undefined;
    const connect = vi.fn(
      async (_target, options) =>
        new Promise((_, reject) => {
          initializationSignal = options?.signal;
          options?.signal?.addEventListener(
            "abort",
            () => {
              reject({ code: "CANCELLED", message: "late secret" });
            },
            { once: true },
          );
        }),
    ) as unknown as McpClientConnector;

    const verification = runMcpVerification({
      target: stdioTarget,
      io: harness.io,
      connect,
    });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(initializationSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(verification).resolves.toBe(1);
    expect(initializationSignal?.aborted).toBe(true);
    expect(harness.stderr).toEqual([
      "invokta-devtools verify: TIMEOUT: The MCP verification deadline expired.\n",
    ]);
  });

  it("closes a connection that resolves after the initialization deadline", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const connection = createConnection();
    let resolveConnection!: (value: McpClientConnection) => void;
    const connect = vi.fn(
      async () =>
        new Promise<McpClientConnection>((resolve) => {
          resolveConnection = resolve;
        }),
    );
    const verification = runMcpVerification({
      target: stdioTarget,
      io: harness.io,
      connect,
    });

    await vi.advanceTimersByTimeAsync(15_000);
    await expect(verification).resolves.toBe(1);
    resolveConnection(connection);
    await vi.waitFor(() => {
      expect(connection.close).toHaveBeenCalledTimes(1);
    });
  });

  it("starts a separate 15-second deadline for the complete catalog and closes on timeout", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    let catalogSignal: AbortSignal | undefined;
    const connection = createConnection({
      listTools: vi.fn(
        async (_cursor, options) =>
          new Promise((_, reject) => {
            catalogSignal = options?.signal;
            options?.signal?.addEventListener(
              "abort",
              () => {
                reject({ code: "CANCELLED", message: "late secret" });
              },
              { once: true },
            );
          }),
      ),
    });

    const verification = runMcpVerification({
      target: stdioTarget,
      io: harness.io,
      connect: connectorFor(connection),
    });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(catalogSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(verification).resolves.toBe(1);
    expect(catalogSignal?.aborted).toBe(true);
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(harness.stderr).toEqual([
      "invokta-devtools verify: TIMEOUT: The MCP verification deadline expired.\n",
    ]);
  });
});
