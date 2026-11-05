import { readdirSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { hostTypeIntrospection, resolveHostTypes } from "../src/host-types.js";

const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));

interface SourceModule {
  readonly path: string;
  readonly text: string;
}

function collectSourceModules(directory: string): SourceModule[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => {
      const absolute = join(entry.parentPath, entry.name);
      return {
        path: relative(sourceRoot, absolute).split(sep).join("/"),
        text: readFileSync(absolute, "utf8"),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

// Comments are scanned too: a commented-out Node import fails the check, which
// keeps the scanner simple and errs on the side of portability.
const specifierPatterns = [
  /\bfrom\s*["']([^"'\n]+)["']/gu,
  /\bimport\s*["']([^"'\n]+)["']/gu,
  /\bimport\s*\(\s*["']([^"'\n]+)["']/gu,
  /\brequire\s*\(\s*["']([^"'\n]+)["']/gu,
] as const;

function specifiersOf(text: string): string[] {
  return specifierPatterns.flatMap((pattern) =>
    Array.from(text.matchAll(pattern), (match) => match[1] ?? ""),
  );
}

function nodeBuiltinImports(modules: ReadonlyArray<SourceModule>): string[] {
  return modules.flatMap((module) =>
    specifiersOf(module.text)
      .filter((specifier) => isBuiltin(specifier))
      .map((specifier) => `${module.path}: ${specifier}`),
  );
}

describe("core runtime portability", () => {
  it("finds every source module of the core", () => {
    const paths = collectSourceModules(sourceRoot).map(({ path }) => path);

    expect(paths).toEqual(
      expect.arrayContaining([
        "composition.ts",
        "connector.ts",
        "engine.ts",
        "host-types.ts",
        "index.ts",
        "schema.ts",
        "types.ts",
      ]),
    );
  });

  it("detects prefixed, bare, subpath, dynamic, and re-exported built-ins", () => {
    const planted: SourceModule = {
      path: "planted.ts",
      text: [
        'import { randomUUID } from "node:crypto";',
        "import {",
        "  types,",
        '} from "util";',
        'import "node:perf_hooks";',
        'export { readFile } from "fs/promises";',
        'const http = await import("node:http");',
        'const os = require("os");',
        'import { createEngine } from "./engine.js";',
        'import type { StandardSchemaV1 } from "@standard-schema/spec";',
      ].join("\n"),
    };

    expect(nodeBuiltinImports([planted])).toEqual([
      "planted.ts: node:crypto",
      "planted.ts: util",
      "planted.ts: fs/promises",
      "planted.ts: node:perf_hooks",
      "planted.ts: node:http",
      "planted.ts: os",
    ]);
  });

  it("imports no Node.js built-in module", () => {
    expect(nodeBuiltinImports(collectSourceModules(sourceRoot))).toEqual([]);
  });

  it("uses trap-free host introspection on Node.js", () => {
    expect(hostTypeIntrospection).toBe("host");
  });
});

describe("host type introspection", () => {
  const nodeUtil = process.getBuiltinModule("node:util");

  it("reads util.types from process.getBuiltinModule", () => {
    const resolved = resolveHostTypes(globalThis);
    const target = { value: "plain" };

    expect(resolved).toBeDefined();
    expect(resolved?.isProxy(new Proxy(target, {}))).toBe(true);
    expect(resolved?.isProxy(target)).toBe(false);
    expect(resolved?.isPromise(Promise.resolve())).toBe(true);
    expect(resolved?.isPromise(Object.create(Promise.prototype))).toBe(false);
  });

  it.each([
    ["no process global", {}],
    ["a non-object process", { process: "node" }],
    ["no getBuiltinModule", { process: {} }],
    ["a non-function getBuiltinModule", { process: { getBuiltinModule: 1 } }],
    [
      "a throwing getBuiltinModule",
      {
        process: {
          getBuiltinModule() {
            throw new Error("unavailable");
          },
        },
      },
    ],
    [
      "a missing util module",
      { process: { getBuiltinModule: () => undefined } },
    ],
    ["util without types", { process: { getBuiltinModule: () => ({}) } }],
    [
      "types without isProxy",
      {
        process: {
          getBuiltinModule: () => ({
            types: { isPromise: nodeUtil.types.isPromise },
          }),
        },
      },
    ],
    [
      "types without isPromise",
      {
        process: {
          getBuiltinModule: () => ({
            types: { isProxy: nodeUtil.types.isProxy },
          }),
        },
      },
    ],
  ])("returns no host introspection for %s", (_label, host) => {
    expect(resolveHostTypes(host)).toBeUndefined();
  });

  it("returns no host introspection when reading the process global throws", () => {
    const host = Object.defineProperty({}, "process", {
      get() {
        throw new Error("process is not available");
      },
    });

    expect(resolveHostTypes(host)).toBeUndefined();
  });
});

describe("portable fallback without host introspection", () => {
  const descriptor = Object.getOwnPropertyDescriptor(
    process,
    "getBuiltinModule",
  );

  afterEach(() => {
    if (descriptor !== undefined) {
      Object.defineProperty(process, "getBuiltinModule", descriptor);
    }
    vi.resetModules();
  });

  async function importCoreWithoutHostIntrospection() {
    Object.defineProperty(process, "getBuiltinModule", {
      configurable: true,
      enumerable: descriptor?.enumerable ?? false,
      writable: true,
      value: undefined,
    });
    vi.resetModules();
    const hostTypes = await import("../src/host-types.js");
    const core = await import("../src/index.js");
    return { hostTypes, core };
  }

  it("selects the portable fallback", async () => {
    const { hostTypes } = await importCoreWithoutHostIntrospection();

    expect(hostTypes.hostTypeIntrospection).toBe("portable");
    expect(hostTypes.isPromise(Promise.resolve())).toBe(true);
    expect(hostTypes.isPromise({})).toBe(false);
  });

  it("still invokes a capability and rejects proxied input and output values", async () => {
    const { core } = await importCoreWithoutHostIntrospection();
    const forwardedOutput = new Proxy({ result: "forwarded" }, {});
    const engine = core.createEngine({
      name: "portable-fallback-engine",
      version: "0.1.0",
      capabilities: {
        echo: core.defineCapability({
          description: "Echoes a value.",
          input: z.object({ value: z.string() }),
          output: z.object({ result: z.string() }),
          access: "public",
          async run({ input }) {
            return { result: input.value };
          },
        }),
        proxied: core.defineCapability({
          description: "Returns a forwarding proxy from its output schema.",
          input: z.object({}),
          output: {
            "~standard": {
              version: 1,
              vendor: "portable-fallback-test",
              validate: () => ({ value: forwardedOutput }),
              jsonSchema: {
                input: () => ({ type: "object" }),
                output: () => ({ type: "object" }),
              },
            },
          },
          access: "public",
          async run() {
            return { result: "ignored" };
          },
        }),
        proxiedInput: core.defineCapability({
          description: "Receives a forwarding proxy from its input schema.",
          input: {
            "~standard": {
              version: 1,
              vendor: "portable-fallback-test",
              validate: () => ({ value: new Proxy({ value: "x" }, {}) }),
              jsonSchema: {
                input: () => ({ type: "object" }),
                output: () => ({ type: "object" }),
              },
            },
          },
          output: z.object({ result: z.string() }),
          access: "public",
          async run() {
            return { result: "must-not-run" };
          },
        }),
      },
    });

    await expect(engine.invoke("echo", { value: "portable" })).resolves.toEqual(
      { result: "portable" },
    );
    await expect(engine.invoke("proxied", {})).rejects.toMatchObject({
      code: "OUTPUT_INVALID",
    });
    await expect(engine.invoke("proxiedInput", {})).rejects.toMatchObject({
      code: "INPUT_INVALID",
    });
  });
});
