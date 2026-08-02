import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  defaultDiscoveryDepth,
  discoverEngineProjects,
} from "../src/engine-discovery.js";
import { createNodeFileSystem } from "../src/node-file-system.js";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "invokta-discovery-"));
  roots.push(root);
  return root;
}

function manifest(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    id: "demo-engine",
    version: "1.0.0",
    title: "Demo Engine",
    description: "Discovery fixture.",
    capabilityIds: ["demo.ping"],
    server: {
      name: "demo-engine",
      entrypoint: "dist/mcp-stdio.js",
      forwardEnv: [],
    },
    ...overrides,
  });
}

function project(
  root: string,
  relative: string,
  options: {
    readonly built?: boolean;
    readonly contents?: string;
  } = {},
): string {
  const directory = join(root, relative);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "invokta.mcp.json"),
    options.contents ?? manifest({ id: relative.replaceAll("/", "-") }),
  );
  if (options.built !== false) {
    mkdirSync(join(directory, "dist"), { recursive: true });
    writeFileSync(
      join(directory, "dist", "mcp-stdio.js"),
      "process.exit(0);\n",
    );
  }
  return directory;
}

function discover(root: string, overrides = {}) {
  const fileSystem = createNodeFileSystem();
  return discoverEngineProjects({
    currentUserId: process.getuid?.() ?? 0,
    directoryReader: fileSystem,
    fileSystem,
    roots: [root],
    ...overrides,
  });
}

describe("engine project discovery", () => {
  it("finds every manifest and reports whether its entry point is built", async () => {
    const root = workspace();
    project(root, "alpha");
    project(root, "nested/beta", { built: false });

    const discovery = await discover(root);

    expect(discovery.projects.map(({ manifest: found }) => found.id)).toEqual([
      "alpha",
      "nested-beta",
    ]);
    expect(
      discovery.projects.map(({ entrypointBuilt }) => entrypointBuilt),
    ).toEqual([true, false]);
    expect(discovery.rejected).toEqual([]);
    expect(discovery.truncated).toBe(false);
  });

  it("finds an engine nested inside another engine project", async () => {
    const root = workspace();
    project(root, "outer");
    project(root, "outer/inner");

    const discovery = await discover(root);

    expect(discovery.projects.map(({ manifest: found }) => found.id)).toEqual([
      "outer",
      "outer-inner",
    ]);
  });

  it("reports an invalid manifest with a stable code instead of dropping it", async () => {
    const root = workspace();
    project(root, "broken", { contents: "{ not json" });
    project(root, "unknown-field", {
      contents: manifest({ id: "unknown-field", extra: true }),
    });

    const discovery = await discover(root);

    expect(discovery.projects).toEqual([]);
    expect(discovery.rejected.map(({ code }) => code)).toEqual([
      "ENGINE_MANIFEST_INVALID",
      "ENGINE_MANIFEST_INVALID",
    ]);
  });

  it("skips dependency, build, and hidden directories", async () => {
    const root = workspace();
    project(root, "node_modules/ghost");
    project(root, "dist/ghost");
    project(root, ".hidden/ghost");
    project(root, "real");

    const discovery = await discover(root);

    expect(discovery.projects.map(({ manifest: found }) => found.id)).toEqual([
      "real",
    ]);
  });

  it("stops at the configured depth", async () => {
    const root = workspace();
    project(root, "a/b/reachable");
    project(root, "a/b/c/d/e/deep");

    const shallow = await discover(root, { maximumDepth: 1 });
    const standard = await discover(root, {
      maximumDepth: defaultDiscoveryDepth,
    });

    expect(shallow.projects).toEqual([]);
    expect(standard.projects.map(({ manifest: found }) => found.id)).toEqual([
      "a-b-reachable",
    ]);
  });

  it("reports truncation when the directory budget is exhausted", async () => {
    const root = workspace();
    project(root, "one");
    project(root, "two");
    project(root, "three");

    const discovery = await discover(root, { maximumDirectories: 2 });

    expect(discovery.truncated).toBe(true);
    expect(discovery.inspectedDirectories).toBe(2);
  });

  it("collapses a root that is already contained by another root", async () => {
    const root = workspace();
    project(root, "alpha");
    const fileSystem = createNodeFileSystem();

    const discovery = await discoverEngineProjects({
      currentUserId: process.getuid?.() ?? 0,
      directoryReader: fileSystem,
      fileSystem,
      roots: [root, join(root, "alpha")],
    });

    expect(discovery.roots).toEqual([root]);
  });

  it("rejects a relative root", async () => {
    const fileSystem = createNodeFileSystem();

    await expect(
      discoverEngineProjects({
        currentUserId: process.getuid?.() ?? 0,
        directoryReader: fileSystem,
        fileSystem,
        roots: ["relative/path"],
      }),
    ).rejects.toMatchObject({ code: "ENGINE_PATH_UNSAFE" });
  });
});
