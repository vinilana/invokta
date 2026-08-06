import type { McpClientConnection } from "@invokta/mcp";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { McpClientConnector } from "../src/verify-mcp.js";
import {
  renderMcpVerificationResult,
  runMcpVerification,
} from "../src/verify-mcp.js";

const catalogByteLimit = 10_485_760;
const stdioTarget = {
  transport: "stdio",
  command: "descriptor-command-canary",
  args: ["descriptor-argument-canary"],
  env: { TARGET_TOKEN: "credential-value-canary" },
} as const;

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

    const result = await runMcpVerification({
      target: stdioTarget,
      connect,
    });

    expect(result).toEqual({
      ok: true,
      status: "ok",
      transport: "stdio",
      server: {
        name: "example-server",
        version: "1.0.0",
        protocolVersion: "2025-11-25",
      },
      pageCount: 3,
      toolCount: 3,
    });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith(
      stdioTarget,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(cursors).toEqual([undefined, "", "cursor-2"]);
    expect(maximumActiveLists).toBe(1);
    expect(connection.callTool).not.toHaveBeenCalled();
    expect(connection.close).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("descriptor-command-canary");
    expect(serialized).not.toContain("credential-value-canary");
    expect(serialized).not.toContain("server-instruction-canary");
    expect(serialized).not.toContain("server-capability-canary");
  });

  it("reports the selected HTTP transport without returning its descriptor", async () => {
    const connection = createConnection();
    const connect = connectorFor(connection);
    const target = {
      transport: "http",
      url: "https://target-url-canary.example/mcp",
      authentication: { type: "bearer", token: "bearer-token-canary" },
    } as const;

    const result = await runMcpVerification({ target, connect });

    expect(result.ok).toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).toContain('"transport":"http"');
    expect(serialized).not.toContain("target-url-canary");
    expect(serialized).not.toContain("bearer-token-canary");
  });

  it("accepts exactly 100 pages and 2,000 tools", async () => {
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

    const result = await runMcpVerification({
      target: stdioTarget,
      connect: connectorFor(connection),
    });

    expect(result.ok).toBe(true);
    expect(connection.listTools).toHaveBeenCalledTimes(100);
    expect(result).toMatchObject({ pageCount: 100, toolCount: 2000 });
  });

  it.each([
    {
      name: "the first page beyond 100",
      makePage: (page: number) => ({
        tools: [],
        ...(page === 101 ? {} : { nextCursor: `page-${String(page + 1)}` }),
      }),
      expectedCalls: 100,
      expectedMessage:
        "The MCP verification limit was exceeded: maxCatalogPages (100).",
      expectedDetails: { limit: "maxCatalogPages", value: 100 },
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
      expectedMessage:
        "The MCP verification limit was exceeded: maxTools (2000).",
      expectedDetails: { limit: "maxTools", value: 2000 },
    },
  ])(
    "rejects $name, names the limit, and closes the connection",
    async (fixture) => {
      let page = 0;
      const connection = createConnection({
        listTools: vi.fn(async () => {
          page += 1;
          return fixture.makePage(page);
        }),
      });

      const result = await runMcpVerification({
        target: stdioTarget,
        connect: connectorFor(connection),
      });

      expect(result).toEqual({
        ok: false,
        code: "LIMIT_EXCEEDED",
        stage: "catalog",
        message: fixture.expectedMessage,
        details: fixture.expectedDetails,
      });
      expect(connection.listTools).toHaveBeenCalledTimes(fixture.expectedCalls);
      expect(connection.close).toHaveBeenCalledTimes(1);
    },
  );

  it("honours configured catalog page and tool limits", async () => {
    const connection = createConnection({
      listTools: vi.fn(async () => ({
        tools: [
          { name: "first", inputSchema: { type: "object" } },
          { name: "second", inputSchema: { type: "object" } },
        ],
      })),
    });

    const result = await runMcpVerification({
      target: stdioTarget,
      connect: connectorFor(connection),
      maxTools: 1,
    });

    expect(result).toEqual({
      ok: false,
      code: "LIMIT_EXCEEDED",
      stage: "catalog",
      message: "The MCP verification limit was exceeded: maxTools (1).",
      details: { limit: "maxTools", value: 1 },
    });
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it("honours a configured catalog byte limit", async () => {
    const connection = createConnection({
      listTools: vi.fn(async () => ({
        tools: [encodedCatalogTool(128)],
      })),
    });

    const result = await runMcpVerification({
      target: stdioTarget,
      connect: connectorFor(connection),
      maxCatalogBytes: 127,
    });

    expect(result).toEqual({
      ok: false,
      code: "LIMIT_EXCEEDED",
      stage: "catalog",
      message:
        "The MCP verification limit was exceeded: maxCatalogBytes (127).",
      details: { limit: "maxCatalogBytes", value: 127 },
    });
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty advertised tool name", async () => {
    const connection = createConnection({
      listTools: vi.fn(async () => ({
        tools: [{ name: "", inputSchema: { type: "object" } }],
      })),
    });

    const result = await runMcpVerification({
      target: stdioTarget,
      connect: connectorFor(connection),
    });

    expect(result).toEqual({
      ok: false,
      code: "PROTOCOL_ERROR",
      stage: "catalog",
      message: "The MCP target returned an invalid protocol response.",
    });
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it("accepts a catalog whose compact UTF-8 encoding is exactly 10 MiB", async () => {
    const connection = createConnection({
      listTools: vi.fn(async () => ({
        tools: [encodedCatalogTool(catalogByteLimit)],
      })),
    });

    const result = await runMcpVerification({
      target: stdioTarget,
      connect: connectorFor(connection),
    });

    expect(result.ok).toBe(true);
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it("rejects the first catalog byte beyond 10 MiB", async () => {
    const connection = createConnection({
      listTools: vi.fn(async () => ({
        tools: [encodedCatalogTool(catalogByteLimit + 1)],
      })),
    });

    const result = await runMcpVerification({
      target: stdioTarget,
      connect: connectorFor(connection),
    });

    expect(result).toEqual({
      ok: false,
      code: "LIMIT_EXCEEDED",
      stage: "catalog",
      message:
        "The MCP verification limit was exceeded: maxCatalogBytes (10485760).",
      details: { limit: "maxCatalogBytes", value: 10_485_760 },
    });
    expect(connection.close).toHaveBeenCalledTimes(1);
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
    let page = 0;
    const connection = createConnection({
      listTools: vi.fn(async () => pages[page++] as (typeof pages)[number]),
    });

    const result = await runMcpVerification({
      target: stdioTarget,
      connect: connectorFor(connection),
    });

    expect(result).toEqual({
      ok: false,
      code: "PROTOCOL_ERROR",
      stage: "catalog",
      message: "The MCP target returned an invalid protocol response.",
    });
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it("sanitizes connector failures and classifies invalid targets", async () => {
    const connect = vi.fn(async () => {
      throw {
        code: "INVALID_TARGET",
        message:
          "descriptor-command-canary credential-value-canary target-url-canary",
        descriptor: stdioTarget,
      };
    }) as unknown as McpClientConnector;

    const result = await runMcpVerification({ target: stdioTarget, connect });

    expect(result).toEqual({
      ok: false,
      code: "INVALID_TARGET",
      stage: "initialize",
      message: "The MCP target is invalid.",
    });
    expect(JSON.stringify(result)).not.toContain("credential-value-canary");
  });

  it("names the executable when the server process fails to spawn", async () => {
    const connect = vi.fn(async () => {
      throw {
        code: "SPAWN_FAILED",
        message: "credential-value-canary target-url-canary",
      };
    }) as unknown as McpClientConnector;

    const result = await runMcpVerification({ target: stdioTarget, connect });

    expect(result).toEqual({
      ok: false,
      code: "SPAWN_FAILED",
      stage: "initialize",
      message:
        'The MCP server process could not start: the executable "descriptor-command-canary" failed to spawn.',
      details: { executable: "descriptor-command-canary" },
    });
    expect(JSON.stringify(result)).not.toContain("credential-value-canary");
    expect(JSON.stringify(result)).not.toContain("target-url-canary");
  });

  it("sanitizes protocol failures, closes once, and ignores a secondary cleanup failure", async () => {
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

    const result = await runMcpVerification({
      target: stdioTarget,
      connect: connectorFor(connection),
    });

    expect(result).toEqual({
      ok: false,
      code: "AUTHENTICATION_FAILED",
      stage: "catalog",
      message: "The MCP target rejected authentication.",
    });
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("bearer-token-canary");
    expect(JSON.stringify(result)).not.toContain("credential-value-canary");
  });

  it("turns cleanup failure after successful validation into a safe connection failure", async () => {
    const connection = createConnection({
      close: vi.fn(async () => {
        throw new Error("credential-value-canary");
      }),
    });

    const result = await runMcpVerification({
      target: stdioTarget,
      connect: connectorFor(connection),
    });

    expect(result).toEqual({
      ok: false,
      code: "CONNECTION_FAILED",
      stage: null,
      message: "The MCP connection failed.",
    });
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("credential-value-canary");
  });

  it("fails unresolved initialization at exactly 15 seconds", async () => {
    vi.useFakeTimers();
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
      connect,
    });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(initializationSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(verification).resolves.toEqual({
      ok: false,
      code: "TIMEOUT",
      stage: "initialize",
      message: "The MCP initialization deadline of 15000 ms expired.",
      details: { stage: "initialize", deadlineMs: 15_000 },
    });
    expect(initializationSignal?.aborted).toBe(true);
  });

  it("honours a configured initialization deadline", async () => {
    vi.useFakeTimers();
    const connect = vi.fn(
      async () =>
        new Promise(() => {
          // Never resolves; the configured deadline must win.
        }),
    ) as unknown as McpClientConnector;

    const verification = runMcpVerification({
      target: stdioTarget,
      connect,
      initializationDeadlineMs: 250,
    });
    await vi.advanceTimersByTimeAsync(249);
    let settled = false;
    void verification.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(verification).resolves.toEqual({
      ok: false,
      code: "TIMEOUT",
      stage: "initialize",
      message: "The MCP initialization deadline of 250 ms expired.",
      details: { stage: "initialize", deadlineMs: 250 },
    });
  });

  it("closes a connection that resolves after the initialization deadline", async () => {
    vi.useFakeTimers();
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
      connect,
    });

    await vi.advanceTimersByTimeAsync(15_000);
    await expect(verification).resolves.toMatchObject({
      ok: false,
      code: "TIMEOUT",
    });
    resolveConnection(connection);
    await vi.waitFor(() => {
      expect(connection.close).toHaveBeenCalledTimes(1);
    });
  });

  it("starts a separate 15-second deadline for the complete catalog and closes on timeout", async () => {
    vi.useFakeTimers();
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
      connect: connectorFor(connection),
    });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(catalogSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(verification).resolves.toEqual({
      ok: false,
      code: "TIMEOUT",
      stage: "catalog",
      message: "The MCP catalog deadline of 15000 ms expired.",
      details: { stage: "catalog", deadlineMs: 15_000 },
    });
    expect(catalogSignal?.aborted).toBe(true);
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it("honours a configured catalog deadline", async () => {
    vi.useFakeTimers();
    const connection = createConnection({
      listTools: vi.fn(
        async () =>
          new Promise(() => {
            // Never resolves; the configured deadline must win.
          }),
      ),
    });

    const verification = runMcpVerification({
      target: stdioTarget,
      connect: connectorFor(connection),
      catalogDeadlineMs: 500,
    });
    await vi.advanceTimersByTimeAsync(500);

    await expect(verification).resolves.toEqual({
      ok: false,
      code: "TIMEOUT",
      stage: "catalog",
      message: "The MCP catalog deadline of 500 ms expired.",
      details: { stage: "catalog", deadlineMs: 500 },
    });
    expect(connection.close).toHaveBeenCalledTimes(1);
  });
});

describe("renderMcpVerificationResult", () => {
  it("renders the legacy success JSON line without the ok discriminant", () => {
    const rendered = renderMcpVerificationResult({
      ok: true,
      status: "ok",
      transport: "stdio",
      server: {
        name: "example-server",
        version: "1.0.0",
        protocolVersion: "2025-11-25",
      },
      pageCount: 3,
      toolCount: 3,
    });

    expect(rendered).toEqual({
      exitCode: 0,
      stdout:
        '{"status":"ok","transport":"stdio","server":{"name":"example-server","version":"1.0.0","protocolVersion":"2025-11-25"},"pageCount":3,"toolCount":3}\n',
    });
  });

  it("renders an invalid target failure with the usage exit code", () => {
    const rendered = renderMcpVerificationResult({
      ok: false,
      code: "INVALID_TARGET",
      stage: "initialize",
      message: "The MCP target is invalid.",
    });

    expect(rendered).toEqual({
      exitCode: 2,
      stderr:
        "invokta-devtools verify: INVALID_TARGET: The MCP target is invalid.\n",
    });
  });

  it("renders an operational failure with the failure exit code", () => {
    const rendered = renderMcpVerificationResult({
      ok: false,
      code: "TIMEOUT",
      stage: "catalog",
      message: "The MCP catalog deadline of 15000 ms expired.",
      details: { stage: "catalog", deadlineMs: 15_000 },
    });

    expect(rendered).toEqual({
      exitCode: 1,
      stderr:
        "invokta-devtools verify: TIMEOUT: The MCP catalog deadline of 15000 ms expired.\n",
    });
  });
});
