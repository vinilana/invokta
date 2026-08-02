import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { discoverEngineProjects } from "../src/engine-discovery.js";
import {
  buildEngineInventory,
  type EngineInventoryRow,
  managedDescriptorFor,
  persistedInstallDescriptorFor,
} from "../src/engine-inventory.js";
import type { EngineProjectMetadata } from "../src/engine-manifest.js";
import type {
  ConfigurationTargetSnapshot,
  HarnessDetectionSnapshot,
} from "../src/harness-detection.js";
import {
  installDescriptorAcrossTargets,
  type MutationCoordinatorDependencies,
} from "../src/mutation-coordinator.js";
import { createNodeFileSystem } from "../src/node-file-system.js";
import type { ConfigurationTargetId } from "../src/registry.js";
import { loadBundledRegistry } from "../src/registry.js";
import {
  configurationTargetAdapters,
  registryCompatibilityAdapters,
} from "../src/target-adapters.js";
import type { InstallerEnvironment } from "../src/target-config-evidence.js";

const homes: string[] = [];

afterAll(() => {
  for (const home of homes) rmSync(home, { force: true, recursive: true });
});

interface Fixture {
  readonly home: string;
  readonly workspace: string;
  readonly cursorConfig: string;
  readonly dependencies: MutationCoordinatorDependencies;
  readonly snapshot: HarnessDetectionSnapshot;
}

function target(
  id: ConfigurationTargetId,
  displayName: string,
  configuration: ConfigurationTargetSnapshot["configuration"],
  overrides: Partial<ConfigurationTargetSnapshot> = {},
): ConfigurationTargetSnapshot {
  return {
    id,
    displayName,
    surfaceIds: [],
    evidence: "installed",
    executables: [],
    configuration,
    eligible: true,
    mayCreateConfiguration: true,
    reloadHint: `Reload ${displayName}.`,
    ...overrides,
  };
}

function fixture(): Fixture {
  const home = mkdtempSync(join(tmpdir(), "invokta-inventory-"));
  homes.push(home);
  const workspace = join(home, "workspace");
  const cursorConfig = join(home, ".cursor", "mcp.json");
  mkdirSync(join(home, ".cursor"), { recursive: true });
  mkdirSync(join(home, ".state"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(
    cursorConfig,
    '{\n  "mcpServers": {\n    "unrelated": { "command": "true", "args": [] }\n  }\n}\n',
  );

  const environment: InstallerEnvironment = {
    get: (name) =>
      name === "XDG_STATE_HOME" ? join(home, ".state") : undefined,
  };
  let clock = Date.parse("2026-08-01T12:00:00.000Z");

  return {
    home,
    workspace,
    cursorConfig,
    dependencies: {
      adapters: configurationTargetAdapters,
      currentUserId: process.getuid?.() ?? 0,
      environment,
      fileSystem: createNodeFileSystem(),
      lock: {
        clock: {
          monotonicNow: () => performance.now(),
          now: () => Date.now(),
          wait: async () => undefined,
        },
        processId: process.pid,
        randomBytes: (length) => randomBytes(length),
      },
      now: () => {
        clock += 1_000;
        return new Date(clock).toISOString();
      },
    },
    snapshot: {
      homeDirectory: home,
      surfaces: [],
      targets: [
        target("cursor", "Cursor", { kind: "present", path: cursorConfig }),
        target(
          "claude-desktop",
          "Claude Desktop",
          { kind: "blocked", code: "TARGET_UNSUPPORTED" },
          {
            evidence: "blocked",
            eligible: false,
            mayCreateConfiguration: false,
          },
        ),
        target(
          "hermes",
          "Hermes Agent",
          { kind: "absent", path: join(home, ".hermes", "config.yaml") },
          {
            evidence: "absent",
            eligible: false,
            mayCreateConfiguration: false,
          },
        ),
      ],
    },
  };
}

function writeProject(
  workspace: string,
  id: string,
  options: { readonly built?: boolean; readonly forwardEnv?: string[] } = {},
): void {
  const directory = join(workspace, id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "invokta.mcp.json"),
    JSON.stringify({
      schemaVersion: 1,
      id,
      version: "1.0.0",
      title: `${id} engine`,
      description: `${id} fixture.`,
      capabilityIds: [`${id}.ping`],
      server: {
        name: id,
        entrypoint: "dist/mcp-stdio.js",
        forwardEnv: options.forwardEnv ?? [],
      },
    }),
  );
  if (options.built !== false) {
    mkdirSync(join(directory, "dist"), { recursive: true });
    writeFileSync(
      join(directory, "dist", "mcp-stdio.js"),
      "process.exit(0);\n",
    );
  }
}

async function projectsIn(
  fixtures: Fixture,
): Promise<readonly EngineProjectMetadata[]> {
  const fileSystem = createNodeFileSystem();
  const discovery = await discoverEngineProjects({
    currentUserId: fixtures.dependencies.currentUserId,
    directoryReader: fileSystem,
    fileSystem: fixtures.dependencies.fileSystem,
    roots: [fixtures.workspace],
  });
  return discovery.projects;
}

async function inventoryOf(fixtures: Fixture) {
  const registry = await loadBundledRegistry(
    fixtures.dependencies.fileSystem,
    registryCompatibilityAdapters,
  );
  return buildEngineInventory({
    dependencies: fixtures.dependencies,
    nodeExecutable: process.execPath,
    projects: await projectsIn(fixtures),
    registry,
    snapshot: fixtures.snapshot,
  });
}

function row(
  inventory: { readonly engines: readonly EngineInventoryRow[] },
  id: string,
): EngineInventoryRow {
  const found = inventory.engines.find((engine) => engine.id === id);
  if (found === undefined) throw new Error(`missing engine ${id}`);
  return found;
}

describe("engine inventory", () => {
  it("classifies a built project as installable and names why a target is not", async () => {
    const fixtures = fixture();
    writeProject(fixtures.workspace, "alpha");

    const inventory = await inventoryOf(fixtures);
    const alpha = row(inventory, "alpha");

    expect(alpha.cells.cursor).toEqual({ state: "installable" });
    expect(alpha.cells["claude-desktop"]).toEqual({
      state: "unavailable",
      reason: { code: "TARGET_BLOCKED", targetCode: "TARGET_UNSUPPORTED" },
    });
    expect(alpha.cells.hermes).toEqual({
      state: "unavailable",
      reason: { code: "TARGET_INELIGIBLE" },
    });
    expect(alpha.installedCount).toBe(0);
    expect(alpha.reachableCount).toBe(1);
    expect(alpha.descriptorSource).toBe("project");
  });

  it("classifies an unbuilt project as needing a build", async () => {
    const fixtures = fixture();
    writeProject(fixtures.workspace, "beta", { built: false });

    const inventory = await inventoryOf(fixtures);

    expect(row(inventory, "beta").cells.cursor).toEqual({
      state: "needs-build",
    });
    expect(row(inventory, "beta").project?.entrypointBuilt).toBe(false);
  });

  it("names the adapter reason when a target refuses the descriptor shape", async () => {
    const fixtures = fixture();
    writeProject(fixtures.workspace, "gamma", { forwardEnv: ["GAMMA_TOKEN"] });
    const kimi = target("kimi-code", "Kimi Code CLI", {
      kind: "present",
      path: join(fixtures.home, ".kimi-code", "mcp.json"),
    });

    const registry = await loadBundledRegistry(
      fixtures.dependencies.fileSystem,
      registryCompatibilityAdapters,
    );
    const inventory = await buildEngineInventory({
      dependencies: fixtures.dependencies,
      nodeExecutable: process.execPath,
      projects: await projectsIn(fixtures),
      registry,
      snapshot: {
        ...fixtures.snapshot,
        targets: [...fixtures.snapshot.targets, kimi],
      },
    });

    expect(row(inventory, "gamma").cells["kimi-code"]).toEqual({
      state: "unavailable",
      reason: {
        code: "TARGET_INCOMPATIBLE",
        reason: "kimi-code-forward-env-unsupported",
      },
    });
  });

  it("reports the owned registration after an install and preserves unrelated bytes", async () => {
    const fixtures = fixture();
    writeProject(fixtures.workspace, "delta");
    const before = readFileSync(fixtures.cursorConfig, "utf8");
    const projects = await projectsIn(fixtures);
    const registry = await loadBundledRegistry(
      fixtures.dependencies.fileSystem,
      registryCompatibilityAdapters,
    );
    const initial = await buildEngineInventory({
      dependencies: fixtures.dependencies,
      nodeExecutable: process.execPath,
      projects,
      registry,
      snapshot: fixtures.snapshot,
    });

    const [result] = await installDescriptorAcrossTargets({
      dependencies: fixtures.dependencies,
      descriptor: {
        id: "delta",
        version: "1.0.0",
        title: "delta engine",
        description: "delta fixture.",
        capabilityIds: ["delta.ping"],
        server: {
          name: "delta",
          transport: {
            type: "stdio",
            command: process.execPath,
            args: [join(fixtures.workspace, "delta", "dist", "mcp-stdio.js")],
            forwardEnv: [],
          },
        },
      },
      snapshot: fixtures.snapshot,
      targetIds: ["cursor"],
    });

    expect(result).toEqual({
      targetId: "cursor",
      pathContract: "posix",
      outcome: "installed",
    });
    expect(row(initial, "delta").cells.cursor).toEqual({
      state: "installable",
    });

    const after = await inventoryOf(fixtures);
    const delta = row(after, "delta");

    expect(delta.cells.cursor).toMatchObject({
      state: "managed",
      status: "enabled",
      actions: ["disable"],
    });
    expect(delta.installedCount).toBe(1);
    expect(managedDescriptorFor(delta, "cursor")?.server.name).toBe("delta");
    expect(readFileSync(fixtures.cursorConfig, "utf8")).toContain(
      before.trim().slice(0, 30),
    );
    expect(readFileSync(fixtures.cursorConfig, "utf8")).toContain("unrelated");
  });

  it("keeps an engine whose project disappeared and offers its persisted descriptor", async () => {
    const fixtures = fixture();
    writeProject(fixtures.workspace, "epsilon");
    await installDescriptorAcrossTargets({
      dependencies: fixtures.dependencies,
      descriptor: {
        id: "epsilon",
        version: "1.0.0",
        title: "epsilon engine",
        description: "epsilon fixture.",
        capabilityIds: ["epsilon.ping"],
        server: {
          name: "epsilon",
          transport: {
            type: "stdio",
            command: process.execPath,
            args: [join(fixtures.workspace, "epsilon", "dist", "mcp-stdio.js")],
            forwardEnv: [],
          },
        },
      },
      snapshot: fixtures.snapshot,
      targetIds: ["cursor"],
    });
    rmSync(join(fixtures.workspace, "epsilon"), {
      force: true,
      recursive: true,
    });

    const inventory = await inventoryOf(fixtures);
    const epsilon = row(inventory, "epsilon");

    expect(epsilon.project).toBeUndefined();
    expect(epsilon.descriptorSource).toBe("state");
    expect(epsilon.cells.cursor).toMatchObject({ state: "managed" });
    expect(persistedInstallDescriptorFor(epsilon)?.id).toBe("epsilon");
  });

  it("offers no persisted install descriptor while the project still exists", async () => {
    const fixtures = fixture();
    writeProject(fixtures.workspace, "zeta");

    const inventory = await inventoryOf(fixtures);

    expect(
      persistedInstallDescriptorFor(row(inventory, "zeta")),
    ).toBeUndefined();
    expect(
      managedDescriptorFor(row(inventory, "zeta"), "cursor"),
    ).toBeUndefined();
  });

  it("performs no write while building the inventory", async () => {
    const fixtures = fixture();
    writeProject(fixtures.workspace, "eta");
    const before = readFileSync(fixtures.cursorConfig, "utf8");

    await inventoryOf(fixtures);
    await inventoryOf(fixtures);

    expect(readFileSync(fixtures.cursorConfig, "utf8")).toBe(before);
  });
});
