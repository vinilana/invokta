import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const sourceRoot = new URL("../src/", import.meta.url);
const hostSimulation = pathToFileURL(
  fileURLToPath(new URL("./fixtures/web-runtime-host.mjs", import.meta.url)),
).href;
const handlerFixture = fileURLToPath(
  new URL("./fixtures/web-runtime-handler.mjs", import.meta.url),
);

const specifierPatterns = [
  /\bfrom\s*["']([^"'\n]+)["']/gu,
  /\bimport\s*["']([^"'\n]+)["']/gu,
  /\bimport\s*\(\s*["']([^"'\n]+)["']/gu,
] as const;

/** Every module the portable entry point reaches inside this package. */
function portableModuleGraph(): ReadonlyMap<string, readonly string[]> {
  const graph = new Map<string, readonly string[]>();
  const pending = ["web.ts"];
  while (pending.length > 0) {
    const module = pending.pop() as string;
    if (graph.has(module)) continue;
    const text = readFileSync(new URL(module, sourceRoot), "utf8");
    const specifiers = specifierPatterns.flatMap((pattern) =>
      Array.from(text.matchAll(pattern), (match) => match[1] ?? ""),
    );
    graph.set(module, specifiers);
    for (const specifier of specifiers) {
      if (specifier.startsWith("./")) {
        pending.push(specifier.slice(2).replace(/\.js$/u, ".ts"));
      }
    }
  }
  return graph;
}

describe("@invokta/mcp/web portability", () => {
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

  it("publishes the portable entry point as the ./web subpath", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { readonly exports: Readonly<Record<string, unknown>> };

    expect(manifest.exports).toEqual({
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./web": { types: "./dist/web.d.ts", import: "./dist/web.js" },
    });
  });

  it("reaches only portable modules and reviewed Web-standard SDK modules", () => {
    const graph = portableModuleGraph();
    const external = new Set(
      [...graph.values()].flat().filter((name) => !name.startsWith("./")),
    );

    expect([...graph.keys()].sort()).toEqual([
      "http-protocol.ts",
      "progress.ts",
      "protocol-server.ts",
      "request-id-transport.ts",
      "sha256.ts",
      "tool-name.ts",
      "web.ts",
    ]);
    expect([...external].filter((name) => isBuiltin(name))).toEqual([]);
    expect([...external].sort()).toEqual([
      "@invokta/core",
      "@modelcontextprotocol/sdk/server/index.js",
      "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js",
      "@modelcontextprotocol/sdk/shared/auth.js",
      "@modelcontextprotocol/sdk/shared/transport.js",
      "@modelcontextprotocol/sdk/types.js",
    ]);
    for (const module of graph.keys()) {
      const text = readFileSync(new URL(module, sourceRoot), "utf8");
      expect(text, module).not.toMatch(/\b(?:Buffer|process)\.[A-Za-z]/u);
    }
  });

  it("serves tools without Node.js built-ins, host introspection, or eval", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--disallow-code-generation-from-strings",
        "--import",
        hostSimulation,
        handlerFixture,
      ],
      { cwd: repositoryRoot, encoding: "utf8", timeout: 20_000 },
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const outcome = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(outcome).toMatchObject({
      getBuiltinModule: "undefined",
      listed: {
        status: 200,
        body: {
          result: {
            tools: [{ name: "support_inspect" }, { name: "support_proxied" }],
          },
        },
      },
      called: {
        status: 200,
        body: {
          result: {
            structuredContent: {
              value: "portable",
              principalId: "user:alice",
              source: "mcp-http",
            },
          },
        },
      },
      proxied: {
        status: 200,
        body: {
          result: {
            isError: true,
            content: [
              { text: expect.stringContaining('"code":"OUTPUT_INVALID"') },
            ],
          },
        },
      },
      unauthorized: { status: 401, challenge: "Bearer" },
    });
  });

  it("refuses the Node.js entry point under the same host simulation", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        hostSimulation,
        "--input-type=module",
        "--eval",
        'await import("./packages/mcp/dist/index.js");',
      ],
      { cwd: repositoryRoot, encoding: "utf8", timeout: 20_000 },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Node\.js built-in node:[a-z_]+ requested/u);
  });
});
