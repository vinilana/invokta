import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createEngine, defineCapability } from "@invokta/core";
import {
  connectMcpClient,
  type McpClientConnection,
  type McpHttpServerHandle,
  serveMcpHttp,
} from "@invokta/mcp";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod";

import type { DevtoolsIo } from "../src/run-devtools-cli.js";
import { runDevtoolsCli } from "../src/run-devtools-cli.js";
import type { McpClientConnector } from "../src/verify-mcp.js";
import {
  renderMcpVerificationResult,
  runMcpVerification,
} from "../src/verify-mcp.js";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const stdioFixturePath = fileURLToPath(
  new URL("./fixtures/verify-mcp-stdio-server.mjs", import.meta.url),
);
const temporaryDirectories: string[] = [];
const httpServers: McpHttpServerHandle[] = [];

interface OutputHarness {
  readonly stdout: string[];
  readonly stderr: string[];
  readonly io: DevtoolsIo;
}

interface AuditRecord {
  readonly kind: "message" | "handler" | "lifecycle";
  readonly method?: string;
  readonly cursor?: string;
  readonly operation?: string;
  readonly state?: string;
}

function createOutputHarness(): OutputHarness {
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

async function createAuditFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "invokta-verify-mcp-"));
  temporaryDirectories.push(directory);
  return join(directory, "audit.jsonl");
}

async function readAudit(path: string): Promise<readonly AuditRecord[]> {
  const text = await readFile(path, "utf8");
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as AuditRecord);
}

function expectReadOnlyProtocol(records: readonly AuditRecord[]): void {
  expect(records).toEqual([
    { kind: "message", method: "initialize" },
    { kind: "message", method: "notifications/initialized" },
    { kind: "message", method: "tools/list" },
    { kind: "lifecycle", state: "closed" },
    { kind: "lifecycle", state: "exited" },
  ]);
  expect(records).not.toContainEqual(
    expect.objectContaining({ method: "tools/call" }),
  );
  expect(records).not.toContainEqual(
    expect.objectContaining({ operation: "tools/call" }),
  );
}

function observingConnector(onClose: () => void): McpClientConnector {
  return async (target, options) => {
    const connection = await connectMcpClient(target, options);
    return {
      server: connection.server,
      listTools: connection.listTools.bind(connection),
      callTool: connection.callTool.bind(connection),
      async close() {
        onClose();
        await connection.close();
      },
    } satisfies McpClientConnection;
  };
}

let toolInvocations = 0;
const httpEngine = createEngine({
  name: "verify-integration-http",
  version: "2.0.0",
  capabilities: {
    "fixture.read-only": defineCapability({
      description: "A tool that verification must advertise but never call.",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      access: "public",
      async run() {
        toolInvocations += 1;
        return { ok: true };
      },
    }),
  },
});

async function startHttpFixture(): Promise<{
  readonly server: McpHttpServerHandle;
  readonly url: string;
}> {
  const server = await serveMcpHttp(httpEngine, {
    port: 0,
    auth: { mode: "dangerously-disabled-for-development" },
  });
  httpServers.push(server);
  const address = server.address();
  return {
    server,
    url: `http://${address.host}:${String(address.port)}/mcp`,
  };
}

function observeHttpProtocol(): string[] {
  const methods: string[] = [];
  const platformFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (typeof init?.body === "string") {
      const message = JSON.parse(init.body) as { readonly method?: unknown };
      if (typeof message.method === "string") methods.push(message.method);
    }
    return platformFetch(input, init);
  });
  return methods;
}

beforeAll(() => {
  execFileSync(
    process.execPath,
    [
      "node_modules/typescript/bin/tsc",
      "-b",
      "packages/core",
      "packages/mcp",
      "packages/devtools",
      "--pretty",
      "false",
    ],
    { cwd: repositoryRoot, stdio: "pipe" },
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  toolInvocations = 0;
  await Promise.allSettled(
    httpServers.splice(0).map((server) => server.close()),
  );
  await Promise.allSettled(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

afterAll(() => {
  delete process.env.VERIFY_MCP_INTEGRATION_AUDIT;
});

describe.sequential("real MCP verification integration", () => {
  it("runMcpVerification traverses the real stdio catalog without a tool call and completes the public close lifecycle", async () => {
    const auditPath = await createAuditFile();
    let closeCount = 0;

    const result = await runMcpVerification({
      target: {
        transport: "stdio",
        command: process.execPath,
        args: [stdioFixturePath],
        cwd: repositoryRoot,
        env: { VERIFY_MCP_AUDIT_FILE: auditPath },
      },
      connect: observingConnector(() => {
        closeCount += 1;
      }),
    });

    expect(result).toEqual({
      ok: true,
      status: "ok",
      transport: "stdio",
      server: {
        name: "verify-integration-stdio",
        version: "1.0.0",
        protocolVersion: "2025-11-25",
      },
      pageCount: 1,
      toolCount: 1,
    });
    expect(closeCount).toBe(1);
    expect(renderMcpVerificationResult(result)).toEqual({
      exitCode: 0,
      stdout:
        '{"status":"ok","transport":"stdio","server":{"name":"verify-integration-stdio","version":"1.0.0","protocolVersion":"2025-11-25"},"pageCount":1,"toolCount":1}\n',
    });
    expectReadOnlyProtocol(await readAudit(auditPath));
  });

  it("the CLI homologates the real stdio descriptor and completes the public close lifecycle", async () => {
    const auditPath = await createAuditFile();
    const output = createOutputHarness();
    process.env.VERIFY_MCP_INTEGRATION_AUDIT = auditPath;

    const exitCode = await runDevtoolsCli({
      argv: [
        "verify",
        "--stdio",
        process.execPath,
        "--arg",
        stdioFixturePath,
        "--cwd",
        repositoryRoot,
        "--env",
        "VERIFY_MCP_AUDIT_FILE=VERIFY_MCP_INTEGRATION_AUDIT",
      ],
      cwd: repositoryRoot,
      io: output.io,
    });

    delete process.env.VERIFY_MCP_INTEGRATION_AUDIT;
    expect(exitCode).toBe(0);
    expect(output.stderr).toEqual([]);
    expect(output.stdout).toEqual([
      '{"status":"ok","transport":"stdio","server":{"name":"verify-integration-stdio","version":"1.0.0","protocolVersion":"2025-11-25"},"pageCount":1,"toolCount":1}\n',
    ]);
    expectReadOnlyProtocol(await readAudit(auditPath));
  });

  it("runMcpVerification validates the real HTTP endpoint and closes the facade connection", async () => {
    const fixture = await startHttpFixture();
    const methods = observeHttpProtocol();
    let closeCount = 0;

    const result = await runMcpVerification({
      target: { transport: "http", url: fixture.url },
      connect: observingConnector(() => {
        closeCount += 1;
      }),
    });

    expect(result).toEqual({
      ok: true,
      status: "ok",
      transport: "http",
      server: {
        name: "verify-integration-http",
        version: "2.0.0",
        protocolVersion: "2025-11-25",
      },
      pageCount: 1,
      toolCount: 1,
    });
    expect(closeCount).toBe(1);
    expect(toolInvocations).toBe(0);
    expect(methods).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
    expect(methods).not.toContain("tools/call");
    expect(renderMcpVerificationResult(result)).toEqual({
      exitCode: 0,
      stdout:
        '{"status":"ok","transport":"http","server":{"name":"verify-integration-http","version":"2.0.0","protocolVersion":"2025-11-25"},"pageCount":1,"toolCount":1}\n',
    });

    await expect(fixture.server.close()).resolves.toBeUndefined();
    const serverIndex = httpServers.indexOf(fixture.server);
    if (serverIndex >= 0) httpServers.splice(serverIndex, 1);
  });

  it("the CLI homologates the real HTTP endpoint without invoking its advertised tool", async () => {
    const fixture = await startHttpFixture();
    const methods = observeHttpProtocol();
    const output = createOutputHarness();

    const exitCode = await runDevtoolsCli({
      argv: ["verify", "--http", fixture.url],
      cwd: repositoryRoot,
      io: output.io,
    });

    expect(exitCode).toBe(0);
    expect(toolInvocations).toBe(0);
    expect(methods).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
    expect(methods).not.toContain("tools/call");
    expect(output.stderr).toEqual([]);
    expect(output.stdout).toEqual([
      '{"status":"ok","transport":"http","server":{"name":"verify-integration-http","version":"2.0.0","protocolVersion":"2025-11-25"},"pageCount":1,"toolCount":1}\n',
    ]);

    await expect(fixture.server.close()).resolves.toBeUndefined();
    const serverIndex = httpServers.indexOf(fixture.server);
    if (serverIndex >= 0) httpServers.splice(serverIndex, 1);
  });
});
