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

import { type FirecrawlStub, startFirecrawlStub } from "./firecrawl-stub.js";

const exampleRoot = fileURLToPath(new URL("..", import.meta.url));
const capabilityId = "crawl.scrape-page";
const toolName = "crawl_scrape-page";
const apiKey = "test-firecrawl-key";
const scrapedMarkdown =
  "# Example Domain\n\nThis domain is for use in examples.";

let stub: FirecrawlStub;

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
  stub = await startFirecrawlStub({ apiKey, pendingStatusResponses: 0 });
});

afterEach(async () => {
  await stub.close();
});

function firecrawlEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    FIRECRAWL_API_KEY: apiKey,
    FIRECRAWL_BASE_URL: stub.baseUrl,
  };
}

interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The Firecrawl stub runs in this process, so entrypoints must be spawned
 * asynchronously: a synchronous child would block the event loop that serves
 * the stub's responses.
 */
async function run(
  entrypoint: string,
  args: readonly string[] = [],
  environment: NodeJS.ProcessEnv = firecrawlEnvironment(),
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

function toolErrorPayload(result: unknown): unknown {
  const content = (result as { readonly content?: unknown }).content;
  if (!Array.isArray(content)) throw new Error("Expected MCP tool content.");
  const text = content.find(
    (item): item is { readonly type: "text"; readonly text: string } =>
      typeof item === "object" &&
      item !== null &&
      "type" in item &&
      item.type === "text" &&
      "text" in item &&
      typeof item.text === "string",
  );
  if (text === undefined) throw new Error("Expected a text tool error.");
  return JSON.parse(text.text) as unknown;
}

describe("crawl engine entrypoints", () => {
  it("scrapes through the direct entrypoint with result-only stdout", async () => {
    const result = await run("direct", ["https://example.com/docs"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      url: "https://example.com/docs",
      title: "Example Domain",
      statusCode: 200,
      markdown: scrapedMarkdown,
    });
  });

  it("fails with a clear message when the Firecrawl credential is missing", async () => {
    const result = await run("cli", ["list"], {
      ...process.env,
      FIRECRAWL_API_KEY: "",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: { code: "EXECUTION_FAILED" },
    });
  });

  it("publishes the same capabilities through the CLI and enforces the host allowlist", async () => {
    const listed = await run("cli", ["list"]);
    expect(listed.status).toBe(0);
    expect(
      (JSON.parse(listed.stdout) as ReadonlyArray<{ id: string }>).map(
        ({ id }) => id,
      ),
    ).toEqual(["crawl.scrape-page", "crawl.map-site", "crawl.crawl-site"]);

    const mapped = await run("cli", [
      "run",
      "crawl.map-site",
      "--input",
      JSON.stringify({ url: "https://example.com/", limit: 2 }),
    ]);
    expect(mapped.status).toBe(0);
    expect(mapped.stderr).toBe("");
    expect(JSON.parse(mapped.stdout)).toEqual({
      url: "https://example.com/",
      links: [
        {
          url: "https://example.com/docs",
          title: "Docs",
          description: "Documentation",
        },
        {
          url: "https://example.com/pricing",
          title: null,
          description: null,
        },
      ],
    });

    const forbidden = await run("cli", [
      "run",
      capabilityId,
      "--input",
      JSON.stringify({ url: "https://competitor.test/pricing" }),
    ]);
    expect(forbidden.status).toBe(1);
    expect(forbidden.stdout).toBe("");
    expect(JSON.parse(forbidden.stderr)).toMatchObject({
      error: { code: "FORBIDDEN" },
    });

    const privateTarget = await run("cli", [
      "run",
      capabilityId,
      "--input",
      JSON.stringify({ url: "http://169.254.169.254/latest/meta-data" }),
    ]);
    expect(privateTarget.status).toBe(1);
    expect(JSON.parse(privateTarget.stderr)).toMatchObject({
      error: { code: "INPUT_INVALID" },
    });
    expect(stub.requests.some(({ path }) => path === "/v2/scrape")).toBe(false);
  });

  it("serves the crawl tools over protocol-only stdio", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["dist/mcp-stdio.js"],
      cwd: exampleRoot,
      env: firecrawlEnvironment() as Record<string, string>,
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    const client = new Client(
      { name: "crawl-stdio-entrypoint-test", version: "0.0.0-test" },
      { capabilities: {} },
    );

    try {
      await client.connect(transport);
      await expect(client.listTools()).resolves.toMatchObject({
        tools: [
          { name: "crawl_scrape-page" },
          { name: "crawl_map-site" },
          { name: "crawl_crawl-site" },
        ],
      });
      await expect(
        client.callTool({
          name: "crawl_crawl-site",
          arguments: { url: "https://example.com/", limit: 2 },
        }),
      ).resolves.toMatchObject({
        structuredContent: {
          url: "https://example.com/",
          pagesCrawled: 2,
        },
      });
    } finally {
      await client.close();
    }

    expect(stderr).toBe("");
  });

  it("serves authenticated stateless HTTP without exposing the crawl credential", async () => {
    const token = "test-only-crawl-token";
    const child = spawn(process.execPath, ["dist/mcp-http.js"], {
      cwd: exampleRoot,
      env: {
        ...firecrawlEnvironment(),
        CRAWL_ENGINE_BEARER_TOKEN: token,
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
          params: {
            name: toolName,
            arguments: { url: "https://example.com/" },
          },
        }),
      });
      expect(unauthenticated.status).toBe(401);
      await unauthenticated.arrayBuffer();

      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      });
      client = new Client(
        { name: "crawl-http-entrypoint-test", version: "0.0.0-test" },
        { capabilities: {} },
      );
      await client.connect(transport as unknown as Transport);
      await expect(
        client.callTool({
          name: toolName,
          arguments: { url: "https://example.com/" },
        }),
      ).resolves.toMatchObject({
        structuredContent: { url: "https://example.com/", statusCode: 200 },
      });

      const forbidden = await client.callTool({
        name: toolName,
        arguments: {
          url: "https://competitor.test/pricing",
          principal: {
            id: "attacker",
            attributes: { allowedHosts: ["competitor.test"] },
          },
        },
      });
      expect(forbidden.isError).toBe(true);
      expect(toolErrorPayload(forbidden)).toMatchObject({ code: "FORBIDDEN" });
    } finally {
      await client?.close().catch(() => undefined);
      await stopProcess(child);
    }

    expect(stdout).toBe("");
    expect(stderr).not.toContain(token);
    expect(stderr).not.toContain(apiKey);
    expect(stderr).not.toContain("attacker");
  });
});
