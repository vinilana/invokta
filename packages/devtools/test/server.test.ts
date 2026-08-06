import { execFileSync, spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createEngine,
  defineCapability,
  type EngineSchema,
} from "@invokta/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ServeHandles } from "../src/serve.js";
import { startServe } from "../src/serve.js";
import { startOnAvailablePort } from "./available-port.js";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const uiRoot = fileURLToPath(new URL("./fixtures/ui", import.meta.url));

type FixtureValue = Readonly<Record<string, unknown>>;

const fixtureSchema = {
  "~standard": {
    version: 1,
    vendor: "invokta-devtools-test",
    validate: (value: unknown) => ({ value }),
    jsonSchema: {
      input: () => ({ type: "object" }),
      output: () => ({ type: "object" }),
    },
  },
} as unknown as EngineSchema<FixtureValue, FixtureValue>;

function buildEngine() {
  return createEngine({
    name: "server-test-engine",
    version: "0.1.0",
    capabilities: {
      "fixture.echo": defineCapability({
        title: "Fixture echo",
        description: "Echoes the fixture input.",
        annotations: { readOnly: true },
        input: fixtureSchema,
        output: fixtureSchema,
        access: "public",
        async run({ input }) {
          return { echoed: input };
        },
      }),
    },
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

async function readSse(
  url: string,
  minimumDataFrames: number,
  action?: () => Promise<void>,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  const response = await fetch(url, { signal: controller.signal });
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = "";
  if (action !== undefined) await action();
  try {
    while ((text.match(/\ndata: /g)?.length ?? 0) < minimumDataFrames) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    // The abort timeout ends a stream that never reached the minimum.
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
  return text;
}

describe("startServe", () => {
  const engine = buildEngine();
  let handles: ServeHandles;
  let base = "";
  let token = "";

  beforeAll(async () => {
    const result = await startOnAvailablePort((port) =>
      startServe({
        engine,
        cwd: repositoryRoot,
        composedCapabilitiesExport: false,
        port,
        uiRoot,
      }),
    );
    if (result.kind !== "started") throw new Error("serve was refused");
    handles = result.handles;
    base = `http://127.0.0.1:${String(handles.devtoolsAddress.port)}`;

    const issued = await fetch(`${base}/api/principals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principal: { id: "tester" } }),
    });
    expect(issued.status).toBe(201);
    token = ((await issued.json()) as { token: string }).token;
  });

  afterAll(async () => {
    await handles?.close();
  });

  function callTool(headers: Readonly<Record<string, string>> = {}) {
    return fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "fixture.echo", arguments: { message: "hi" } },
      }),
    });
  }

  it("describes the engine on /api/engine", async () => {
    const response = await fetch(`${base}/api/engine`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      name: "server-test-engine",
      version: "0.1.0",
      capabilityCount: 1,
      engineHost: { host: "127.0.0.1", port: handles.engineAddress.port },
    });
  });

  it("publishes full capability descriptions on /api/capabilities", async () => {
    const response = await fetch(`${base}/api/capabilities`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as ReadonlyArray<{
      readonly id: string;
      readonly inputSchema: unknown;
      readonly outputSchema: unknown;
    }>;
    expect(body).toHaveLength(1);
    expect(body[0]?.id).toBe("fixture.echo");
    expect(body[0]?.inputSchema).toEqual({ type: "object" });
    expect(body[0]?.outputSchema).toEqual({ type: "object" });
  });

  it("serves the doctor report on /api/doctor", async () => {
    const response = await fetch(`${base}/api/doctor`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly engineName: string;
      readonly findings: readonly unknown[];
      readonly notes: ReadonlyArray<{ readonly code: string }>;
    };
    expect(body.engineName).toBe("server-test-engine");
    expect(body.findings).toEqual([]);
    expect(body.notes.map((note) => note.code)).toContain(
      "MCP_MANIFEST_MISSING",
    );
  });

  it("lists principals without exposing tokens", async () => {
    const response = await fetch(`${base}/api/principals`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as ReadonlyArray<
      Readonly<Record<string, unknown>>
    >;
    expect(body.length).toBeGreaterThanOrEqual(2);
    for (const entry of body) {
      expect(Object.keys(entry).sort()).toEqual(["key", "principal"]);
    }
  });

  it("rotates and removes principals through the API", async () => {
    const issued = await fetch(`${base}/api/principals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principal: { id: "rotating" } }),
    });
    const created = (await issued.json()) as {
      readonly key: string;
      readonly token: string;
    };

    const rotated = await fetch(`${base}/api/principals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: created.key }),
    });
    expect(rotated.status).toBe(200);
    const rotatedBody = (await rotated.json()) as { readonly token: string };
    expect(rotatedBody.token).not.toBe(created.token);

    const removed = await fetch(`${base}/api/principals`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: created.key }),
    });
    expect(removed.status).toBe(200);

    const removedAgain = await fetch(`${base}/api/principals`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: created.key }),
    });
    expect(removedAgain.status).toBe(404);
  });

  it("proxies an authenticated tools/call to the engine host", async () => {
    const response = await callTool({ authorization: `Bearer ${token}` });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly result: { readonly structuredContent: unknown };
    };
    expect(body.result.structuredContent).toEqual({
      echoed: { message: "hi" },
    });
  });

  it("passes the engine host's 401 challenge through unchanged", async () => {
    const response = await callTool();

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("rejects a foreign-origin POST before proxying", async () => {
    const response = await callTool({
      authorization: `Bearer ${token}`,
      origin: "http://attacker.example",
    });

    expect(response.status).toBe(403);
  });

  it("rejects a foreign Host header", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        {
          host: "127.0.0.1",
          port: handles.devtoolsAddress.port,
          path: "/api/engine",
          method: "GET",
          headers: { host: "attacker.example" },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.once("error", reject);
      request.end();
    });

    expect(status).toBe(403);
  });

  it("never emits Access-Control headers", async () => {
    const responses = await Promise.all([
      fetch(`${base}/`),
      fetch(`${base}/api/engine`),
      fetch(`${base}/api/capabilities`),
      fetch(`${base}/api/doctor`),
      fetch(`${base}/api/principals`),
      callTool({ authorization: `Bearer ${token}` }),
      fetch(`${base}/unknown`),
    ]);

    for (const response of responses) {
      for (const name of response.headers.keys()) {
        expect(name.toLowerCase().startsWith("access-control-")).toBe(false);
      }
    }
  });

  it("serves the interface bundle and refuses traversal", async () => {
    const index = await fetch(`${base}/`);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("fixture-interface-page");

    const asset = await fetch(`${base}/assets/app.js`);
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain("fixture-interface-script");

    const traversal = await fetch(`${base}/assets/..%2Fserver.test.ts`);
    expect(traversal.status).toBe(404);
    const missing = await fetch(`${base}/assets/absent.js`);
    expect(missing.status).toBe(404);
  });

  it("streams trace entries over /api/events", async () => {
    const text = await readSse(`${base}/api/events`, 2, async () => {
      const response = await callTool({ authorization: `Bearer ${token}` });
      await response.arrayBuffer();
    });

    expect(text).toContain("event: trace");
    expect(text).toContain('"kind":"invocation"');
    expect(text).toContain('"kind":"exchange"');
    expect(text).toContain('"capabilityId":"fixture.echo"');
  });

  it("responds 404 on unknown routes and 405 on wrong methods", async () => {
    const unknown = await fetch(`${base}/unknown`);
    expect(unknown.status).toBe(404);

    const wrongMethod = await fetch(`${base}/api/engine`, { method: "POST" });
    expect(wrongMethod.status).toBe(405);

    const wrongMcp = await fetch(`${base}/mcp`);
    expect(wrongMcp.status).toBe(405);
  });
});

describe("startServe preflight", () => {
  it("refuses an engine that fails the doctor checks", async () => {
    const brokenEngine = {
      name: "broken",
      version: "0.1.0",
      invoke: async () => ({}),
      list: () => [{ id: "fixture.broken", description: "Broken." }],
      describe: () => {
        throw new Error("Fixture describe failed.");
      },
    };

    const result = await startServe({
      engine: brokenEngine,
      cwd: repositoryRoot,
      composedCapabilitiesExport: false,
      uiRoot,
    });

    expect(result.kind).toBe("refused");
    if (result.kind === "refused") {
      expect(result.report.findings[0]?.code).toBe("DESCRIBE_FAILED");
    }
  });
});

describe("invokta-devtools serve", () => {
  beforeAll(() => {
    execFileSync(
      process.execPath,
      [
        "node_modules/typescript/bin/tsc",
        "-b",
        "packages/devtools",
        "--pretty",
        "false",
      ],
      { cwd: repositoryRoot, stdio: "pipe" },
    );
  });

  it("prints one ready line, serves, and shuts down cleanly on SIGTERM", async () => {
    const port = await freePort();
    const child = spawn(
      process.execPath,
      [
        join("packages/devtools/dist", "cli.js"),
        "serve",
        "packages/devtools/test/fixtures/valid-engine.js",
        "--port",
        String(port),
      ],
      { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const readyLine = `Invokta devtools listening on http://127.0.0.1:${String(port)}/\n`;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`serve never became ready: ${stderr}`)),
        8000,
      );
      const poll = setInterval(() => {
        if (stdout.includes(readyLine)) {
          clearTimeout(timeout);
          clearInterval(poll);
          resolve();
        }
      }, 50);
    });

    const response = await fetch(`http://127.0.0.1:${String(port)}/api/engine`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { name: string }).name).toBe(
      "fixture-engine",
    );

    const exitCode = await new Promise<number | null>((resolve) => {
      child.once("exit", (code) => resolve(code));
      child.kill("SIGTERM");
    });

    expect(exitCode).toBe(0);
    expect(stdout).toBe(readyLine);
  }, 20_000);
});
