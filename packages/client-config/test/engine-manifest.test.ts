import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadEngineInstallManifest,
  loadEngineRemovalManifest,
  validateEngineInstallManifestBytes,
} from "../src/engine-manifest.js";
import { createNodeFileSystem } from "../src/node-file-system.js";

const temporaryDirectories: string[] = [];

function createProject(): string {
  const directory = mkdtempSync(join(tmpdir(), "invokta-engine-manifest-"));
  temporaryDirectories.push(directory);
  mkdirSync(join(directory, "dist"));
  writeFileSync(join(directory, "dist/mcp-stdio.js"), "export {};\n");
  writeFileSync(
    join(directory, "invokta.mcp.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "support-engine",
      version: "1.2.3",
      title: "Support Engine",
      description: "Customer support actions.",
      capabilityIds: ["tickets.summarize"],
      server: {
        name: "support-engine",
        entrypoint: "dist/mcp-stdio.js",
        forwardEnv: ["SUPPORT_TOKEN"],
      },
    }),
  );
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("loadEngineInstallManifest", () => {
  function expectInvalidManifest(operation: () => unknown): void {
    let error: unknown;
    try {
      operation();
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "ENGINE_MANIFEST_INVALID" });
  }

  it("resolves an immutable stdio descriptor without executing the engine", async () => {
    const projectDirectory = createProject();
    const nodeExecutable = process.execPath;

    const source = await loadEngineInstallManifest({
      currentUserId: process.getuid?.() ?? 0,
      fileSystem: createNodeFileSystem(),
      nodeExecutable,
      projectDirectory,
    });

    expect(source).toEqual({
      manifestPath: join(projectDirectory, "invokta.mcp.json"),
      entrypointPath: join(projectDirectory, "dist/mcp-stdio.js"),
      descriptor: {
        id: "support-engine",
        version: "1.2.3",
        title: "Support Engine",
        description: "Customer support actions.",
        capabilityIds: ["tickets.summarize"],
        server: {
          name: "support-engine",
          transport: {
            type: "stdio",
            command: nodeExecutable,
            args: [join(projectDirectory, "dist/mcp-stdio.js")],
            forwardEnv: ["SUPPORT_TOKEN"],
          },
        },
      },
    });
    expect(Object.isFrozen(source)).toBe(true);
    expect(Object.isFrozen(source.descriptor.server.transport)).toBe(true);
  });

  it.each([
    ["a UTF-8 BOM", '\uFEFF{"schemaVersion":1}'],
    ["a duplicate property", '{"schemaVersion":1,"id":"first","id":"second"}'],
    ["an unknown property", '{"schemaVersion":1,"id":"x","unexpected":true}'],
    [
      "a parent entrypoint segment",
      '{"schemaVersion":1,"id":"x","version":"1","title":"X","description":"X","capabilityIds":["x"],"server":{"name":"x","entrypoint":"../server.js","forwardEnv":[]}}',
    ],
    [
      "a backslash entrypoint",
      '{"schemaVersion":1,"id":"x","version":"1","title":"X","description":"X","capabilityIds":["x"],"server":{"name":"x","entrypoint":"dist\\\\server.js","forwardEnv":[]}}',
    ],
    [
      "duplicate forwarded environment names",
      '{"schemaVersion":1,"id":"x","version":"1","title":"X","description":"X","capabilityIds":["x"],"server":{"name":"x","entrypoint":"server.js","forwardEnv":["TOKEN","TOKEN"]}}',
    ],
  ])("rejects %s", (_label, contents) => {
    expectInvalidManifest(() =>
      validateEngineInstallManifestBytes(new TextEncoder().encode(contents)),
    );
  });

  it("rejects a manifest above the one MiB byte limit", () => {
    expectInvalidManifest(() =>
      validateEngineInstallManifestBytes(new Uint8Array(1_048_577)),
    );
  });

  it("distinguishes an absent entry point", async () => {
    const projectDirectory = createProject();
    rmSync(join(projectDirectory, "dist/mcp-stdio.js"));

    await expect(
      loadEngineInstallManifest({
        currentUserId: process.getuid?.() ?? 0,
        fileSystem: createNodeFileSystem(),
        nodeExecutable: process.execPath,
        projectDirectory,
      }),
    ).rejects.toMatchObject({ code: "ENGINE_ENTRYPOINT_MISSING" });
  });

  it("rejects a symbolic-link entry point", async () => {
    const projectDirectory = createProject();
    const entrypoint = join(projectDirectory, "dist/mcp-stdio.js");
    rmSync(entrypoint);
    symlinkSync(join(projectDirectory, "invokta.mcp.json"), entrypoint);

    await expect(
      loadEngineInstallManifest({
        currentUserId: process.getuid?.() ?? 0,
        fileSystem: createNodeFileSystem(),
        nodeExecutable: process.execPath,
        projectDirectory,
      }),
    ).rejects.toMatchObject({ code: "ENGINE_PATH_UNSAFE" });
  });
});

describe("loadEngineRemovalManifest", () => {
  it("validates owned manifest metadata without requiring the entry point", async () => {
    const projectDirectory = createProject();
    rmSync(join(projectDirectory, "dist/mcp-stdio.js"));

    const source = await loadEngineRemovalManifest({
      currentUserId: process.getuid?.() ?? 0,
      fileSystem: createNodeFileSystem(),
      projectDirectory,
    });

    expect(source).toEqual({
      manifestPath: join(projectDirectory, "invokta.mcp.json"),
      id: "support-engine",
      title: "Support Engine",
      serverName: "support-engine",
    });
    expect(Object.isFrozen(source)).toBe(true);
  });

  it("retains strict manifest validation when the entry point is absent", async () => {
    const projectDirectory = createProject();
    rmSync(join(projectDirectory, "dist/mcp-stdio.js"));
    writeFileSync(
      join(projectDirectory, "invokta.mcp.json"),
      '{"schemaVersion":1,"id":"support-engine","unexpected":true}',
    );

    await expect(
      loadEngineRemovalManifest({
        currentUserId: process.getuid?.() ?? 0,
        fileSystem: createNodeFileSystem(),
        projectDirectory,
      }),
    ).rejects.toMatchObject({ code: "ENGINE_MANIFEST_INVALID" });
  });
});
