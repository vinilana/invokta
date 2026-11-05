import { readdirSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  hostTypeIntrospection,
  identifiesAsNodeJs,
  resolveHostTypes,
  selectHostTypes,
} from "../src/host-types.js";

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

describe("Node.js host identification", () => {
  const nodeProcess = {
    versions: { node: "22.2.0", v8: "12.4.254.14-node.12" },
    release: { name: "node" },
  };

  it("identifies the current Node.js process", () => {
    expect(identifiesAsNodeJs(globalThis)).toBe(true);
  });

  it.each([
    [
      "Node.js with navigator",
      { process: nodeProcess, navigator: { userAgent: "Node.js/22" } },
    ],
    ["Node.js without navigator", { process: nodeProcess }],
  ])("identifies %s", (_label, host) => {
    expect(identifiesAsNodeJs(host)).toBe(true);
  });

  it.each([
    ["no process global", {}],
    ["a process without versions", { process: { release: { name: "node" } } }],
    [
      "a process without a Node.js version",
      { process: { versions: {}, release: { name: "node" } } },
    ],
    [
      "a different release name",
      { process: { ...nodeProcess, release: { name: "io.js" } } },
    ],
    [
      "Deno",
      {
        process: {
          ...nodeProcess,
          versions: { ...nodeProcess.versions, deno: "2.5.0" },
        },
      },
    ],
    ["the Deno global", { process: nodeProcess, Deno: {} }],
    [
      "Bun",
      {
        process: {
          ...nodeProcess,
          versions: { ...nodeProcess.versions, bun: "1.4.4" },
        },
      },
    ],
    ["the Bun global", { process: nodeProcess, Bun: {} }],
    ["an Edge runtime", { process: nodeProcess, EdgeRuntime: "edge-runtime" }],
    [
      "a Worker user agent",
      { process: nodeProcess, navigator: { userAgent: "Cloudflare-Workers" } },
    ],
    [
      "a throwing process global",
      Object.defineProperty({}, "process", {
        get() {
          throw new Error("process is not available");
        },
      }),
    ],
  ])("does not identify %s as Node.js", (_label, host) => {
    expect(identifiesAsNodeJs(host)).toBe(false);
  });

  it("fails closed when Node.js lacks trap-free introspection", () => {
    const shadowed = {
      process: {
        ...nodeProcess,
        getBuiltinModule() {
          throw new Error("blocked by a sandbox");
        },
      },
    };

    expect(() => selectHostTypes({ process: nodeProcess })).toThrow(
      'process.getBuiltinModule("node:util")',
    );
    expect(() => selectHostTypes(shadowed)).toThrow(
      "@invokta/core requires util.types",
    );
    expect(selectHostTypes(globalThis)).toBeDefined();
  });

  it("selects the portable fallback on a host that is not Node.js", () => {
    expect(
      selectHostTypes({
        process: nodeProcess,
        navigator: { userAgent: "Cloudflare-Workers" },
      }),
    ).toBeUndefined();
    expect(selectHostTypes({})).toBeUndefined();
  });
});

describe("portable fallback without host introspection", () => {
  const descriptor = Object.getOwnPropertyDescriptor(
    process,
    "getBuiltinModule",
  );
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator",
  );

  afterEach(() => {
    if (descriptor !== undefined) {
      Object.defineProperty(process, "getBuiltinModule", descriptor);
    }
    if (navigatorDescriptor !== undefined) {
      Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    }
    vi.resetModules();
  });

  function removeHostIntrospection(): void {
    Object.defineProperty(process, "getBuiltinModule", {
      configurable: true,
      enumerable: descriptor?.enumerable ?? false,
      writable: true,
      value: undefined,
    });
  }

  async function importCoreWithoutHostIntrospection() {
    removeHostIntrospection();
    // Present a Web host's user agent so this Node.js process is not
    // identified as Node.js and the portable fallback applies.
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      enumerable: true,
      value: { userAgent: "Invokta-Portable-Host-Test" },
    });
    vi.resetModules();
    const hostTypes = await import("../src/host-types.js");
    const schema = await import("../src/schema.js");
    const core = await import("../src/index.js");
    return { hostTypes, schema, core };
  }

  it("clones a snapshot once and rejects nested proxies", async () => {
    const { schema } = await importCoreWithoutHostIntrospection();
    const clone = vi.spyOn(globalThis, "structuredClone");

    try {
      const snapshot = schema.snapshotLosslessJson({ list: [1, { a: "b" }] });

      expect(clone).toHaveBeenCalledOnce();
      expect(snapshot).toEqual({ list: [1, { a: "b" }] });
      expect(Object.isFrozen(snapshot.list[1])).toBe(true);
      expect(() =>
        schema.snapshotLosslessJson({ nested: [new Proxy({}, {})] }),
      ).toThrow(TypeError);
    } finally {
      clone.mockRestore();
    }
  });

  it("refuses to load on Node.js without trap-free introspection", async () => {
    removeHostIntrospection();
    vi.resetModules();

    await expect(import("../src/index.js")).rejects.toThrow(
      "@invokta/core requires util.types",
    );
  });

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
        domain: core.defineCapability({
          description: "Raises a declared domain error.",
          input: z.object({}),
          output: z.object({ ok: z.boolean() }),
          access: "public",
          errors: {
            SLOT_CONFLICT: {
              description: "The requested slot is no longer available.",
              details: z.object({ slotId: z.string() }),
            },
          },
          async run() {
            throw new core.CapabilityError("SLOT_CONFLICT", {
              details: { slotId: "S-1" },
            });
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
    await expect(engine.invoke("domain", {})).rejects.toMatchObject({
      code: "DOMAIN_ERROR",
      publicDetails: { code: "SLOT_CONFLICT", details: { slotId: "S-1" } },
    });
  });
});
