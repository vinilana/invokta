import {
  type ChildProcessWithoutNullStreams,
  spawn,
  spawnSync,
} from "node:child_process";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const exampleRoot = fileURLToPath(new URL("..", import.meta.url));

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

function run(entrypoint: string, args: readonly string[] = []) {
  return spawnSync(process.execPath, [`dist/${entrypoint}.js`, ...args], {
    cwd: exampleRoot,
    encoding: "utf8",
  });
}

function nextMessage(
  child: ChildProcessWithoutNullStreams,
  expectedId: number,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line === "") continue;
        const message = JSON.parse(line) as Record<string, unknown>;
        if (message.id === expectedId) {
          child.stdout.off("data", onData);
          resolve(message);
        }
      }
    };
    child.stdout.on("data", onData);
    child.once("error", reject);
    child.once("exit", (code) => {
      reject(new Error(`MCP stdio server exited before response: ${code}`));
    });
  });
}

function send(child: ChildProcessWithoutNullStreams, message: unknown): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

describe("hello engine entrypoints", () => {
  it("runs the capability directly", () => {
    const result = run("direct", ["Ada"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      message: "Hello, Ada! Welcome to your first Action Engine.",
    });
  });

  it("runs the same capability through the CLI", () => {
    const result = run("cli", [
      "run",
      "onboarding.create-welcome-message",
      "--input",
      '{"name":"Ada"}',
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      message: "Hello, Ada! Welcome to your first Action Engine.",
    });
  });

  it("runs the same capability over MCP stdio without non-protocol stdout", async () => {
    const child = spawn(process.execPath, ["dist/mcp-stdio.js"], {
      cwd: exampleRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    try {
      const initialized = nextMessage(child, 1);
      send(child, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "hello-example-test", version: "0.0.0-test" },
        },
      });
      await expect(initialized).resolves.toMatchObject({
        result: {
          serverInfo: { name: "hello-engine", version: "0.1.0" },
        },
      });
      send(child, {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });

      const called = nextMessage(child, 2);
      send(child, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "onboarding_create-welcome-message",
          arguments: { name: "Ada" },
        },
      });
      await expect(called).resolves.toMatchObject({
        result: {
          structuredContent: {
            message: "Hello, Ada! Welcome to your first Action Engine.",
          },
        },
      });
    } finally {
      child.kill();
    }
    expect(stderr).toBe("");
  });

  it("runs the same capability over authenticated stateless MCP HTTP", async () => {
    const child = spawn(process.execPath, ["dist/mcp-http.js"], {
      cwd: exampleRoot,
      env: {
        ...process.env,
        HELLO_ENGINE_DEMO_TOKEN: "test-only-token",
        HELLO_ENGINE_PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    try {
      const port = await new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`HTTP server did not start:\n${stderr}`)),
          5_000,
        );
        child.stderr.on("data", () => {
          const match = stderr.match(/127\.0\.0\.1:(\d+)\/mcp/u);
          if (match?.[1] !== undefined) {
            clearTimeout(timeout);
            resolve(Number(match[1]));
          }
        });
        child.once("exit", (code) => {
          clearTimeout(timeout);
          reject(new Error(`HTTP server exited before startup: ${code}`));
        });
      });
      const url = `http://127.0.0.1:${port}/mcp`;
      const requestBody = JSON.stringify({
        jsonrpc: "2.0",
        id: "hello-http",
        method: "tools/call",
        params: {
          name: "onboarding_create-welcome-message",
          arguments: { name: "Ada" },
        },
      });
      const unauthenticated = await fetch(url, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: requestBody,
      });
      expect(unauthenticated.status).toBe(401);

      const wrongCredential = await fetch(url, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer wrong-token",
          "content-type": "application/json",
        },
        body: requestBody,
      });
      expect(wrongCredential.status).toBe(401);

      const response = await fetch(url, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer test-only-token",
          "content-type": "application/json",
        },
        body: requestBody,
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        result: {
          structuredContent: {
            message: "Hello, Ada! Welcome to your first Action Engine.",
          },
        },
      });
    } finally {
      child.kill();
    }
    expect(stdout).toBe("");
    expect(stderr).not.toContain("test-only-token");
  });

  it("fails closed when the HTTP demo token is not configured", () => {
    const result = spawnSync(process.execPath, ["dist/mcp-http.js"], {
      cwd: exampleRoot,
      env: { ...process.env, HELLO_ENGINE_DEMO_TOKEN: undefined },
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("HELLO_ENGINE_DEMO_TOKEN is required");
  });
});
