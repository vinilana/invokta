import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { beforeAll, describe, expect, it } from "vitest";

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

const richResult = {
  content: [
    {
      type: "text",
      text: JSON.stringify({
        caption: "Q3",
        voice: { mimeType: "audio/wav" },
        report,
      }),
    },
    { type: "image", data: chart, mimeType: "image/png" },
    { type: "audio", data: voice, mimeType: "audio/wav" },
    { type: "resource_link", ...report },
  ],
  structuredContent: {
    caption: "Q3",
    chart,
    voice: { mimeType: "audio/wav", data: voice },
    report,
  },
};

const plainResult = {
  content: [{ type: "text", text: JSON.stringify({ data: chart }) }],
  structuredContent: { data: chart },
};

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
    const child = spawn(process.execPath, [fixturePath, "http"], {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = once(child, "exit");
    let client: Client | undefined;
    try {
      const lines = createInterface({ input: child.stdout });
      const [line] = (await once(lines, "line")) as [string];
      lines.close();
      const address = JSON.parse(line) as { host: string; port: number };
      client = new Client(
        { name: "rich-content-http-test", version: "0.0.0-test" },
        { capabilities: {} },
      );
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://${address.host}:${String(address.port)}/mcp`),
        ) as unknown as Transport,
      );
      await expectRichToolResults(client);
    } finally {
      await client?.close().catch(() => undefined);
      child.kill("SIGTERM");
      await exited;
    }
  });
});
