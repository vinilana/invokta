import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startImageMcpHttp } from "../src/mcp-http.js";
import { type ProviderStub, startProviderStub } from "./provider-stub.js";

const exampleRoot = fileURLToPath(new URL("..", import.meta.url));
const referenceData = Buffer.from("reference png").toString("base64");
const referenceImages = [
  { mimeType: "image/png", base64Data: referenceData },
  { mimeType: "image/png", base64Data: referenceData },
];

let stub: ProviderStub;

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
  stub = await startProviderStub();
});

afterEach(async () => {
  await stub.close();
});

function providerEnvironment(): NodeJS.ProcessEnv & Record<string, string> {
  return {
    ...process.env,
    OPENAI_API_KEY: "openai-stub-key",
    OPENAI_BASE_URL: stub.openAiBaseUrl,
    ARK_API_KEY: "seedream-stub-key",
    BYTEPLUS_ARK_BASE_URL: stub.seedreamBaseUrl,
    GEMINI_API_KEY: "gemini-stub-key",
    GEMINI_BASE_URL: stub.geminiBaseUrl,
  } as NodeJS.ProcessEnv & Record<string, string>;
}

interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(
  entrypoint: string,
  args: readonly string[] = [],
): Promise<CommandResult> {
  const child = spawn(process.execPath, [`dist/${entrypoint}.js`, ...args], {
    cwd: exampleRoot,
    env: providerEnvironment(),
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

describe("image engine entrypoints", () => {
  it("renders text through the direct engine invocation", async () => {
    const result = await run("direct", [
      "A restrained product launch poster.",
      "SHIP THE RIGHT THING",
    ]);

    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      image: { mimeType: "image/png", base64Data: stub.generatedData },
    });
    expect(stub.requests.at(-1)).toMatchObject({
      path: "/openai/v1/images/generations",
      authorization: "Bearer openai-stub-key",
    });
  });

  it("publishes and invokes the same engine through the CLI", async () => {
    const listed = await run("cli", ["list"]);
    expect(listed.status).toBe(0);
    expect(
      (JSON.parse(listed.stdout) as ReadonlyArray<{ id: string }>).map(
        ({ id }) => id,
      ),
    ).toEqual([
      "image.edit-asset",
      "image.render-text-asset",
      "image.generate-campaign-series",
      "image.compose-reference-asset",
    ]);

    const generated = await run("cli", [
      "run",
      "image.generate-campaign-series",
      "--input",
      JSON.stringify({ prompt: "A coherent launch series.", count: 2 }),
    ]);
    expect(generated.status).toBe(0);
    expect(
      (JSON.parse(generated.stdout) as { images: unknown[] }).images,
    ).toHaveLength(2);
    expect(stub.requests.at(-1)).toMatchObject({
      path: "/ark/api/v3/images/generations",
      authorization: "Bearer seedream-stub-key",
    });
  });

  it("composes references through protocol-only MCP stdio", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["dist/mcp-stdio.js"],
      cwd: exampleRoot,
      env: providerEnvironment(),
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    const client = new Client(
      { name: "image-stdio-entrypoint-test", version: "0.0.0-test" },
      { capabilities: {} },
    );

    try {
      await client.connect(transport);
      await expect(
        client.callTool({
          name: "image_compose-reference-asset",
          arguments: {
            prompt: "Compose a new product scene.",
            referenceImages,
          },
        }),
      ).resolves.toMatchObject({
        structuredContent: {
          image: { mimeType: "image/png", base64Data: stub.generatedData },
        },
      });
    } finally {
      await client.close();
    }
    expect(stderr).toBe("");
    expect(stub.requests.at(-1)).toMatchObject({
      path: "/gemini/v1beta/interactions",
      geminiApiKey: "gemini-stub-key",
    });
  });

  it("authenticates MCP HTTP before invoking an image edit", async () => {
    const token = "image-engine-http-token";
    const server = await startImageMcpHttp(
      { expectedBearerToken: token, port: 0 },
      providerEnvironment(),
    );
    const url = new URL(
      `http://${server.address().host}:${String(server.address().port)}/mcp`,
    );
    let client: Client | undefined;

    try {
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
          params: {
            name: "image_edit-asset",
            arguments: {
              prompt: "Change the background.",
              referenceImages: referenceImages.slice(0, 1),
            },
          },
        }),
      });
      expect(unauthenticated.status).toBe(401);
      await unauthenticated.arrayBuffer();
      expect(stub.requests).toHaveLength(0);

      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      });
      client = new Client(
        { name: "image-http-entrypoint-test", version: "0.0.0-test" },
        { capabilities: {} },
      );
      await client.connect(transport as unknown as Transport);
      await expect(
        client.callTool({
          name: "image_edit-asset",
          arguments: {
            prompt: "Change the background.",
            referenceImages: referenceImages.slice(0, 1),
          },
        }),
      ).resolves.toMatchObject({
        structuredContent: {
          image: { mimeType: "image/png", base64Data: stub.generatedData },
        },
      });
      expect(stub.requests.at(-1)).toMatchObject({
        path: "/openai/v1/images/edits",
        authorization: "Bearer openai-stub-key",
      });
    } finally {
      await client?.close().catch(() => undefined);
      await server.close();
    }
  });
});
