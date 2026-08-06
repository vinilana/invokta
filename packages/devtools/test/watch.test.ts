import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ServeHandles } from "../src/serve.js";
import { startServe } from "../src/serve.js";
import { startOnAvailablePort } from "./available-port.js";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
let projectRoot = "";

const workingBuildScript = `import { copyFileSync, mkdirSync } from "node:fs";
mkdirSync("out", { recursive: true });
copyFileSync("engine-source.js", "out/engine.js");
`;

const failingBuildScript = `process.exit(1);
`;

function engineSource(greeting: string): string {
  return `import { createEngine, defineCapability } from "@invokta/core";

const schema = () => ({
  "~standard": {
    version: 1,
    vendor: "watch-fixture",
    validate: (value) => ({ value }),
    jsonSchema: {
      input: () => ({ type: "object" }),
      output: () => ({ type: "object" }),
    },
  },
});

export const engine = createEngine({
  name: "watch-fixture-engine",
  version: "1.0.0",
  capabilities: {
    "fixture.greet": defineCapability({
      description: "Greets with the built value.",
      input: schema(),
      output: schema(),
      access: "public",
      async run() {
        return { greeting: ${JSON.stringify(greeting)} };
      },
    }),
  },
});
`;
}

async function waitFor<Value>(
  probe: () => Promise<Value | undefined>,
  timeoutMs: number,
  label: string,
): Promise<Value> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
}

describe("serve --watch", () => {
  let handles: ServeHandles;
  let base = "";
  let token = "";

  beforeAll(async () => {
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

    projectRoot = mkdtempSync(join(tmpdir(), "invokta-devtools-watch-"));
    // Outside the repository the fixture cannot resolve workspace
    // dependencies on its own; link the hoisted modules in.
    symlinkSync(
      join(repositoryRoot, "node_modules"),
      join(projectRoot, "node_modules"),
      "dir",
    );
    writeFileSync(join(projectRoot, "engine-source.js"), engineSource("one"));
    writeFileSync(join(projectRoot, "build.mjs"), workingBuildScript);
    execFileSync(process.execPath, ["build.mjs"], {
      cwd: projectRoot,
      stdio: "pipe",
    });

    const result = await startOnAvailablePort((port) =>
      startServe({
        cwd: projectRoot,
        port,
        watch: {
          moduleSpecifier: "out/engine.js",
          exportName: "engine",
          buildCommand: `${JSON.stringify(process.execPath)} build.mjs`,
        },
      }),
    );
    if (result.kind !== "started") {
      throw new Error(`watch serve did not start: ${result.kind}`);
    }
    handles = result.handles;
    base = `http://127.0.0.1:${String(handles.devtoolsAddress.port)}`;

    const issued = await fetch(`${base}/api/principals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principal: { id: "watcher" } }),
    });
    token = ((await issued.json()) as { token: string }).token;
  }, 30_000);

  afterAll(async () => {
    await handles?.close();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  async function greet(): Promise<string | undefined> {
    let response: Response;
    try {
      response = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "fixture.greet", arguments: {} },
        }),
      });
    } catch {
      return undefined;
    }
    if (response.status !== 200) return undefined;
    const body = (await response.json()) as {
      readonly result?: {
        readonly structuredContent?: { readonly greeting?: string };
      };
    };
    return body.result?.structuredContent?.greeting;
  }

  async function hasNotice(notice: string): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      const response = await fetch(`${base}/api/events`, {
        signal: controller.signal,
      });
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let text = "";
      // The buffered session replay arrives immediately after connecting.
      for (let reads = 0; reads < 20; reads += 1) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        if (text.includes(`"notice":"${notice}"`)) return true;
        if (text.endsWith("\n\n")) break;
      }
      return text.includes(`"notice":"${notice}"`);
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }

  it("serves the engine from the child host", async () => {
    expect(await greet()).toBe("one");

    const info = await fetch(`${base}/api/engine`);
    const body = (await info.json()) as {
      readonly name: string;
      readonly capabilityCount: number;
    };
    expect(body.name).toBe("watch-fixture-engine");
    expect(body.capabilityCount).toBe(1);
  });

  it("rebuilds and replaces the child after a source change", async () => {
    writeFileSync(join(projectRoot, "engine-source.js"), engineSource("two"));

    const greeting = await waitFor(
      async () => {
        const value = await greet();
        return value === "two" ? value : undefined;
      },
      15_000,
      "the rebuilt engine",
    );

    expect(greeting).toBe("two");
    expect(await hasNotice("engine-restarted")).toBe(true);
  }, 20_000);

  it("keeps the running host when the build fails", async () => {
    writeFileSync(join(projectRoot, "build.mjs"), failingBuildScript);
    writeFileSync(join(projectRoot, "engine-source.js"), engineSource("three"));

    await waitFor(
      async () => ((await hasNotice("build-failed")) ? true : undefined),
      15_000,
      "the failed build notice",
    );

    expect(await greet()).toBe("two");
  }, 20_000);
});
