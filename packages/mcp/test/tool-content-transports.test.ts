import {
  type ChildProcessWithoutNullStreams,
  execFileSync,
  spawn,
} from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createEngine, defineCapability } from "@invokta/core";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createMcpHttpHandler } from "../src/web.js";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const fixturePath = fileURLToPath(
  new URL("./fixtures/rich-content-server.mjs", import.meta.url),
);

const chart = Buffer.from("chart png bytes").toString("base64");
const voice = Buffer.from("voice wav bytes").toString("base64");
const report = {
  uri: "https://reports.example/q3.pdf",
  name: "q3-report",
  mimeType: "application/pdf",
};
const structuredContent = {
  caption: "Q3",
  chart,
  voice: { mimeType: "audio/wav", data: voice },
  report,
};

const richResult = {
  content: [
    {
      type: "text",
      text: JSON.stringify({
        caption: "Q3",
        chart: "[content 1: image/png]",
        voice: { mimeType: "audio/wav", data: "[content 2: audio/wav]" },
        report,
      }),
    },
    { type: "image", data: chart, mimeType: "image/png" },
    { type: "audio", data: voice, mimeType: "audio/wav" },
    { type: "resource_link", ...report },
  ],
  structuredContent,
};

/** The result for a revision before audio and resource links existed. */
const imageOnlyResult = {
  content: [
    {
      type: "text",
      text: JSON.stringify({
        ...structuredContent,
        chart: "[content 1: image/png]",
      }),
    },
    { type: "image", data: chart, mimeType: "image/png" },
  ],
  structuredContent,
};

const plainResult = {
  content: [{ type: "text", text: JSON.stringify({ data: chart }) }],
  structuredContent: { data: chart },
};

const renderCall = {
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: { name: "media_render", arguments: { caption: "Q3" } },
} as const;

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

async function expectRichToolResults(client: Client): Promise<void> {
  const listed = await client.listTools();
  expect(
    listed.tools.find(({ name }) => name === "media_render")?.outputSchema
      ?.properties,
  ).toMatchObject({
    chart: { contentEncoding: "base64", contentMediaType: "image/png" },
  });
  await expect(
    client.callTool({ name: "media_render", arguments: { caption: "Q3" } }),
  ).resolves.toEqual(richResult);
  await expect(
    client.callTool({ name: "media_plain", arguments: {} }),
  ).resolves.toEqual(plainResult);
}

async function startHttpFixture(): Promise<{
  readonly url: URL;
  readonly stop: () => Promise<void>;
}> {
  const child = spawn(process.execPath, [fixturePath, "http"], {
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  const lines = createInterface({ input: child.stdout });
  const [line] = (await once(lines, "line")) as [string];
  lines.close();
  const address = JSON.parse(line) as { host: string; port: number };
  return {
    url: new URL(`http://${address.host}:${String(address.port)}/mcp`),
    async stop() {
      child.kill("SIGTERM");
      await exited;
    },
  };
}

/** Exchanges raw newline-delimited JSON-RPC with a stdio fixture process. */
function rawStdio(child: ChildProcessWithoutNullStreams) {
  const responses = new Map<unknown, Record<string, unknown>>();
  const waiters = new Map<
    unknown,
    (message: Record<string, unknown>) => void
  >();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line) as Record<string, unknown>;
    const waiter = waiters.get(message.id);
    if (waiter === undefined) responses.set(message.id, message);
    else waiter(message);
  });
  return {
    send(message: Readonly<Record<string, unknown>>) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    response(id: number): Promise<Record<string, unknown>> {
      const ready = responses.get(id);
      if (ready !== undefined) return Promise.resolve(ready);
      return new Promise((resolve) => waiters.set(id, resolve));
    },
  };
}

describe("rich MCP tool result content over both transports", () => {
  it("returns native image, audio, and resource-link blocks over stdio", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fixturePath, "stdio"],
      cwd: repositoryRoot,
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    const client = new Client(
      { name: "rich-content-stdio-test", version: "0.0.0-test" },
      { capabilities: {} },
    );

    try {
      await client.connect(transport);
      await expectRichToolResults(client);
    } finally {
      await client.close();
    }
    expect(stderr).toBe("");
  });

  it("returns the same blocks over stateless HTTP", async () => {
    const fixture = await startHttpFixture();
    let client: Client | undefined;
    try {
      client = new Client(
        { name: "rich-content-http-test", version: "0.0.0-test" },
        { capabilities: {} },
      );
      await client.connect(
        new StreamableHTTPClientTransport(fixture.url) as unknown as Transport,
      );
      await expectRichToolResults(client);
    } finally {
      await client?.close().catch(() => undefined);
      await fixture.stop();
    }
  });

  it("emits only the block types that the stdio session negotiated", async () => {
    const child = spawn(process.execPath, [fixturePath, "stdio"], {
      cwd: repositoryRoot,
      stdio: "pipe",
    });
    const exited = once(child, "exit");
    try {
      const wire = rawStdio(child);
      wire.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "legacy-client", version: "0.0.0-test" },
        },
      });
      await expect(wire.response(1)).resolves.toMatchObject({
        result: { protocolVersion: "2024-11-05" },
      });
      wire.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      wire.send(renderCall);
      await expect(wire.response(2)).resolves.toEqual({
        jsonrpc: "2.0",
        id: 2,
        result: imageOnlyResult,
      });
    } finally {
      child.stdin.end();
      await exited;
    }
  });

  it.each([
    ["2024-11-05", ["text", "image"]],
    [undefined, ["text", "image", "audio"]],
    ["2025-06-18", ["text", "image", "audio", "resource_link"]],
  ])(
    "emits only the block types that HTTP protocol %s defines",
    async (version, types) => {
      const fixture = await startHttpFixture();
      try {
        const response = await fetch(fixture.url, {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            ...(version === undefined
              ? {}
              : { "mcp-protocol-version": version }),
          },
          body: JSON.stringify(renderCall),
        });
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          result: {
            content: { type: string }[];
            structuredContent: unknown;
          };
        };
        expect(body.result.content.map(({ type }) => type)).toEqual(types);
        expect(body.result.structuredContent).toEqual(structuredContent);
        if (version === "2024-11-05")
          expect(body.result).toEqual(imageOnlyResult);
      } finally {
        await fixture.stop();
      }
    },
  );
});

describe("rich MCP tool result content through the Web handler", () => {
  const handler = createMcpHttpHandler(
    createEngine({
      name: "rich-content-web-engine",
      version: "0.1.0",
      capabilities: {
        "media.render": defineCapability({
          description: "Returns annotated image, audio, and link content.",
          input: z.object({}),
          output: z.object({
            chart: z.string().meta({
              contentEncoding: "base64",
              contentMediaType: "image/png",
            }),
            speech: z.string().meta({
              contentEncoding: "base64",
              contentMediaType: "audio/wav",
            }),
            report: z.object({
              uri: z.httpUrl().meta({ contentMediaType: "text/uri-list" }),
              name: z.string(),
            }),
          }),
          access: "public",
          async run() {
            return {
              chart,
              speech: voice,
              report: { uri: report.uri, name: report.name },
            };
          },
        }),
      },
    }),
    { auth: { mode: "dangerously-disabled-for-development" } },
  );

  it.each([
    ["2024-11-05", ["text", "image"]],
    [undefined, ["text", "image", "audio"]],
    ["2025-06-18", ["text", "image", "audio", "resource_link"]],
    ["2025-11-25", ["text", "image", "audio", "resource_link"]],
  ])(
    "emits only the block types that protocol %s defines",
    async (version, types) => {
      const response = await handler(
        new Request("http://127.0.0.1:3000/mcp", {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            ...(version === undefined
              ? {}
              : { "mcp-protocol-version": version }),
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "media_render", arguments: {} },
          }),
        }),
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        result: { content: { type: string }[]; structuredContent: unknown };
      };
      expect(body.result.content.map(({ type }) => type)).toEqual(types);
      expect(body.result.structuredContent).toEqual({
        chart,
        speech: voice,
        report: { uri: report.uri, name: report.name },
      });
    },
  );
});
