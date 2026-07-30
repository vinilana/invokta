import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { HarnessDetectionSnapshot } from "../src/harness-detection.js";
import type { InteractivePrompter } from "../src/interactive-prompter.js";
import { inspectManagedInstallations } from "../src/managed-installations.js";
import { runManagementSession } from "../src/management-session.js";
import {
  installDescriptorAcrossTargets,
  type MutationCoordinatorDependencies,
  mutateDescriptorAcrossTargets,
  removeEngineDescriptorFromTarget,
} from "../src/mutation-coordinator.js";
import { createNodeFileSystem } from "../src/node-file-system.js";
import type { CapabilityInstallDescriptor } from "../src/registry.js";
import { configurationTargetAdapters } from "../src/target-adapters.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function snapshot(homeDirectory: string): HarnessDetectionSnapshot {
  const target = (
    id: "codex" | "cursor",
    path: string,
  ): HarnessDetectionSnapshot["targets"][number] => ({
    id,
    displayName: id === "codex" ? "Codex" : "Cursor",
    surfaceIds: [],
    evidence: "installed",
    executables: [],
    configuration: { kind: "absent", path },
    eligible: true,
    mayCreateConfiguration: true,
    reloadHint: `Reload ${id}.`,
  });
  return {
    homeDirectory,
    surfaces: [],
    targets: [
      target("codex", join(homeDirectory, ".codex/config.toml")),
      target("cursor", join(homeDirectory, ".cursor/mcp.json")),
    ],
  };
}

function descriptor(): CapabilityInstallDescriptor {
  return {
    id: "support-engine",
    version: "1.0.0",
    title: "Support Engine",
    description: "Support actions.",
    capabilityIds: ["tickets.summarize"],
    server: {
      name: "support-engine",
      transport: {
        type: "stdio",
        command: process.execPath,
        args: ["/workspace/support-engine/dist/mcp-stdio.js"],
        forwardEnv: [],
      },
    },
  };
}

function updatedDescriptor(): CapabilityInstallDescriptor {
  return {
    ...descriptor(),
    version: "2.0.0",
    server: {
      name: descriptor().server.name,
      transport: {
        type: "stdio",
        command: process.execPath,
        args: ["/workspace/support-engine/dist/mcp-stdio-v2.js"],
        forwardEnv: [],
      },
    },
  };
}

function dependencies(): MutationCoordinatorDependencies {
  let wallTime = Date.parse("2026-07-29T12:00:00.000Z");
  let monotonic = 0;
  let token = 0;
  return {
    adapters: configurationTargetAdapters,
    currentUserId: process.getuid?.() ?? 0,
    environment: { get: () => undefined },
    fileSystem: createNodeFileSystem(),
    lock: {
      clock: {
        monotonicNow: () => monotonic,
        now: () => wallTime,
        wait: async (milliseconds) => {
          monotonic += milliseconds;
          wallTime += milliseconds;
        },
      },
      processId: 123,
      randomBytes: (length) => {
        token += 1;
        return new Uint8Array(length).fill(token);
      },
    },
    now: () => new Date(wallTime).toISOString(),
  };
}

describe("installer mutation coordinator", () => {
  it("installs one descriptor independently in multiple targets and records ownership", async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "invokta-mutation-"));
    temporaryDirectories.push(homeDirectory);

    const results = await installDescriptorAcrossTargets({
      dependencies: dependencies(),
      descriptor: descriptor(),
      snapshot: snapshot(homeDirectory),
      targetIds: ["codex", "cursor"],
    });

    expect(results).toEqual([
      { targetId: "codex", outcome: "installed" },
      { targetId: "cursor", outcome: "installed" },
    ]);
    expect(
      readFileSync(join(homeDirectory, ".codex/config.toml"), "utf8"),
    ).toContain("[mcp_servers.support-engine]");
    expect(
      JSON.parse(readFileSync(join(homeDirectory, ".cursor/mcp.json"), "utf8")),
    ).toMatchObject({
      mcpServers: {
        "support-engine": {
          command: process.execPath,
          args: ["/workspace/support-engine/dist/mcp-stdio.js"],
        },
      },
    });
    const state = JSON.parse(
      readFileSync(
        join(homeDirectory, ".local/state/invokta/installer.json"),
        "utf8",
      ),
    ) as {
      readonly installations: Readonly<
        Record<string, { readonly launchDescriptor?: unknown }>
      >;
    };
    expect(Object.keys(state.installations)).toHaveLength(2);
    expect(Object.values(state.installations)[0]?.launchDescriptor).toEqual(
      descriptor().server,
    );
  });

  it("keeps successful targets when a later target conflicts", async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "invokta-mutation-"));
    temporaryDirectories.push(homeDirectory);
    const detected = snapshot(homeDirectory);
    const cursor = detected.targets[1];
    if (cursor?.configuration.kind !== "absent") throw new Error("fixture");
    const fileSystem = createNodeFileSystem();
    const deps = { ...dependencies(), fileSystem };
    const codex = detected.targets[0];
    if (codex === undefined) throw new Error("fixture");
    await installDescriptorAcrossTargets({
      dependencies: deps,
      descriptor: descriptor(),
      snapshot: { ...detected, targets: [codex] },
      targetIds: ["codex"],
    });

    const results = await installDescriptorAcrossTargets({
      dependencies: deps,
      descriptor: {
        ...descriptor(),
        server: {
          ...descriptor().server,
          name: "other-engine",
        },
      },
      snapshot: detected,
      targetIds: ["codex", "cursor"],
    });

    expect(results[0]).toMatchObject({ targetId: "codex", outcome: "failed" });
    expect(results[1]).toEqual({ targetId: "cursor", outcome: "installed" });
  });

  it("disables and re-enables native and detached installations", async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "invokta-mutation-"));
    temporaryDirectories.push(homeDirectory);
    const detected = snapshot(homeDirectory);
    const deps = dependencies();
    await installDescriptorAcrossTargets({
      dependencies: deps,
      descriptor: descriptor(),
      snapshot: detected,
      targetIds: ["codex", "cursor"],
    });

    const disabled = await mutateDescriptorAcrossTargets({
      action: "disable",
      dependencies: deps,
      descriptor: descriptor(),
      snapshot: detected,
      targetIds: ["codex", "cursor"],
    });

    expect(disabled).toEqual([
      { targetId: "codex", outcome: "disabled" },
      { targetId: "cursor", outcome: "disabled" },
    ]);
    expect(
      readFileSync(join(homeDirectory, ".codex/config.toml"), "utf8"),
    ).toContain("enabled = false");
    expect(
      JSON.parse(readFileSync(join(homeDirectory, ".cursor/mcp.json"), "utf8")),
    ).toEqual({ mcpServers: {} });
    const views = await inspectManagedInstallations({
      dependencies: deps,
      registry: { schemaVersion: 1, entries: [] },
      snapshot: detected,
    });
    expect(
      views.map(({ installation, status }) => ({
        targetId: installation.targetId,
        status,
      })),
    ).toEqual([
      { targetId: "codex", status: "disabled" },
      { targetId: "cursor", status: "disabled" },
    ]);
    expect(
      views.every(({ descriptor: selected }) => selected !== undefined),
    ).toBe(true);

    const enabled = await mutateDescriptorAcrossTargets({
      action: "enable",
      dependencies: deps,
      descriptor: descriptor(),
      snapshot: detected,
      targetIds: ["codex", "cursor"],
    });

    expect(enabled).toEqual([
      { targetId: "codex", outcome: "enabled" },
      { targetId: "cursor", outcome: "enabled" },
    ]);
    expect(
      readFileSync(join(homeDirectory, ".codex/config.toml"), "utf8"),
    ).toContain("enabled = true");
    expect(
      JSON.parse(readFileSync(join(homeDirectory, ".cursor/mcp.json"), "utf8")),
    ).toHaveProperty("mcpServers.support-engine.command", process.execPath);

    const removed = await mutateDescriptorAcrossTargets({
      action: "remove",
      dependencies: deps,
      descriptor: descriptor(),
      snapshot: detected,
      targetIds: ["codex", "cursor"],
    });

    expect(removed).toEqual([
      { targetId: "codex", outcome: "removed" },
      { targetId: "cursor", outcome: "removed" },
    ]);
    expect(
      readFileSync(join(homeDirectory, ".codex/config.toml"), "utf8"),
    ).not.toContain("support-engine");
    expect(
      JSON.parse(readFileSync(join(homeDirectory, ".cursor/mcp.json"), "utf8")),
    ).toEqual({ mcpServers: {} });
    const finalState = JSON.parse(
      readFileSync(
        join(homeDirectory, ".local/state/invokta/installer.json"),
        "utf8",
      ),
    ) as { readonly installations: Readonly<Record<string, unknown>> };
    expect(finalState.installations).toEqual({});
  });

  it("explicitly updates enabled native and detached installations", async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "invokta-mutation-"));
    temporaryDirectories.push(homeDirectory);
    const detected = snapshot(homeDirectory);
    const deps = dependencies();
    await installDescriptorAcrossTargets({
      dependencies: deps,
      descriptor: descriptor(),
      snapshot: detected,
      targetIds: ["codex", "cursor"],
    });

    const results = await installDescriptorAcrossTargets({
      dependencies: deps,
      descriptor: updatedDescriptor(),
      snapshot: detected,
      targetIds: ["codex", "cursor"],
    });

    expect(results).toEqual([
      { targetId: "codex", outcome: "installed" },
      { targetId: "cursor", outcome: "installed" },
    ]);
    expect(
      readFileSync(join(homeDirectory, ".codex/config.toml"), "utf8"),
    ).toContain("mcp-stdio-v2.js");
    expect(
      readFileSync(join(homeDirectory, ".cursor/mcp.json"), "utf8"),
    ).toContain("mcp-stdio-v2.js");
    const state = JSON.parse(
      readFileSync(
        join(homeDirectory, ".local/state/invokta/installer.json"),
        "utf8",
      ),
    ) as {
      readonly installations: Readonly<
        Record<
          string,
          {
            readonly registryVersion: string;
            readonly launchDescriptor?: CapabilityInstallDescriptor["server"];
          }
        >
      >;
    };
    expect(
      Object.values(state.installations).every(
        ({ registryVersion, launchDescriptor }) =>
          registryVersion === "2.0.0" &&
          launchDescriptor?.transport.type === "stdio" &&
          launchDescriptor.transport.args[0]?.endsWith("mcp-stdio-v2.js") ===
            true,
      ),
    ).toBe(true);
  });

  it("updates disabled definitions without enabling them", async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "invokta-mutation-"));
    temporaryDirectories.push(homeDirectory);
    const detected = snapshot(homeDirectory);
    const deps = dependencies();
    await installDescriptorAcrossTargets({
      dependencies: deps,
      descriptor: descriptor(),
      snapshot: detected,
      targetIds: ["codex", "cursor"],
    });
    await mutateDescriptorAcrossTargets({
      action: "disable",
      dependencies: deps,
      descriptor: descriptor(),
      snapshot: detected,
      targetIds: ["codex", "cursor"],
    });

    const results = await installDescriptorAcrossTargets({
      dependencies: deps,
      descriptor: updatedDescriptor(),
      snapshot: detected,
      targetIds: ["codex", "cursor"],
    });

    expect(results).toEqual([
      { targetId: "codex", outcome: "installed" },
      { targetId: "cursor", outcome: "installed" },
    ]);
    const codex = readFileSync(
      join(homeDirectory, ".codex/config.toml"),
      "utf8",
    );
    expect(codex).toContain("mcp-stdio-v2.js");
    expect(codex).toContain("enabled = false");
    expect(
      JSON.parse(readFileSync(join(homeDirectory, ".cursor/mcp.json"), "utf8")),
    ).toEqual({ mcpServers: {} });
    const views = await inspectManagedInstallations({
      dependencies: deps,
      registry: { schemaVersion: 1, entries: [] },
      snapshot: detected,
    });
    expect(views.map(({ status }) => status)).toEqual(["disabled", "disabled"]);
    expect(
      views.every(
        ({ installation }) => installation.registryVersion === "2.0.0",
      ),
    ).toBe(true);
  });

  it("preserves the mode of an existing client configuration", async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "invokta-mutation-"));
    temporaryDirectories.push(homeDirectory);
    const configPath = join(homeDirectory, ".codex/config.toml");
    mkdirSync(join(homeDirectory, ".codex"), { recursive: true });
    writeFileSync(configPath, "# keep\n", { mode: 0o640 });

    const result = await installDescriptorAcrossTargets({
      dependencies: dependencies(),
      descriptor: descriptor(),
      snapshot: snapshot(homeDirectory),
      targetIds: ["codex"],
    });

    expect(result).toEqual([{ targetId: "codex", outcome: "installed" }]);
    expect(statSync(configPath).mode & 0o7777).toBe(0o640);
  });

  it("reports a managed target as unavailable when detection becomes blocked", async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "invokta-mutation-"));
    temporaryDirectories.push(homeDirectory);
    const detected = snapshot(homeDirectory);
    const deps = dependencies();
    await installDescriptorAcrossTargets({
      dependencies: deps,
      descriptor: descriptor(),
      snapshot: detected,
      targetIds: ["codex"],
    });
    const codex = detected.targets[0];
    const cursor = detected.targets[1];
    if (codex === undefined || cursor === undefined) throw new Error("fixture");
    const blocked = {
      ...codex,
      evidence: "blocked",
      configuration: {
        kind: "blocked",
        code: "HARNESS_CONFIG_UNSAFE",
      },
      eligible: false,
      mayCreateConfiguration: false,
    } as const;

    const views = await inspectManagedInstallations({
      dependencies: deps,
      registry: { schemaVersion: 1, entries: [] },
      snapshot: { ...detected, targets: [blocked, cursor] },
    });

    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ status: "unavailable", actions: [] });
  });

  it("distinguishes a concurrent complete removal from lost ownership", async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "invokta-mutation-"));
    temporaryDirectories.push(homeDirectory);
    const detected = snapshot(homeDirectory);
    const deps = dependencies();
    await installDescriptorAcrossTargets({
      dependencies: deps,
      descriptor: descriptor(),
      snapshot: detected,
      targetIds: ["codex"],
    });
    const statePath = join(
      homeDirectory,
      ".local/state/invokta/installer.json",
    );
    writeFileSync(statePath, '{"schemaVersion":1,"installations":{}}\n');
    writeFileSync(
      join(homeDirectory, ".codex/config.toml"),
      "# removed concurrently\n",
    );

    await expect(
      removeEngineDescriptorFromTarget({
        dependencies: deps,
        descriptor: descriptor(),
        manifestServerName: "support-engine",
        snapshot: detected,
        targetId: "codex",
      }),
    ).resolves.toEqual({ targetId: "codex", outcome: "unchanged" });

    await installDescriptorAcrossTargets({
      dependencies: deps,
      descriptor: descriptor(),
      snapshot: detected,
      targetIds: ["codex"],
    });
    writeFileSync(statePath, '{"schemaVersion":1,"installations":{}}\n');

    await expect(
      removeEngineDescriptorFromTarget({
        dependencies: deps,
        descriptor: descriptor(),
        manifestServerName: "support-engine",
        snapshot: detected,
        targetId: "codex",
      }),
    ).resolves.toEqual({
      targetId: "codex",
      outcome: "failed",
      code: "INSTALLATION_UNAVAILABLE",
    });
  });

  it("revalidates engine identity under the transaction locks", async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "invokta-mutation-"));
    temporaryDirectories.push(homeDirectory);
    const detected = snapshot(homeDirectory);
    const deps = dependencies();
    await installDescriptorAcrossTargets({
      dependencies: deps,
      descriptor: descriptor(),
      snapshot: detected,
      targetIds: ["codex"],
    });
    await installDescriptorAcrossTargets({
      dependencies: deps,
      descriptor: { ...descriptor(), id: "different-engine" },
      snapshot: detected,
      targetIds: ["cursor"],
    });

    await expect(
      removeEngineDescriptorFromTarget({
        dependencies: deps,
        descriptor: descriptor(),
        manifestServerName: "support-engine",
        snapshot: detected,
        targetId: "codex",
      }),
    ).resolves.toEqual({
      targetId: "codex",
      outcome: "failed",
      code: "ENGINE_IDENTITY_MISMATCH",
    });
    expect(
      readFileSync(join(homeDirectory, ".codex/config.toml"), "utf8"),
    ).toContain("support-engine");
  });

  it("reports a missing runtime as an explicit status state", async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "invokta-mutation-"));
    temporaryDirectories.push(homeDirectory);
    const detected = snapshot(homeDirectory);
    const deps = dependencies();
    await installDescriptorAcrossTargets({
      dependencies: deps,
      descriptor: descriptor(),
      snapshot: detected,
      targetIds: ["codex"],
    });
    const note = vi.fn();
    const prompter = {
      intro: vi.fn(),
      outro: vi.fn(),
      cancel: vi.fn(),
      autocomplete: vi.fn(),
      select: vi.fn(),
      multiselect: vi.fn(),
      note,
      confirm: vi.fn(),
      spinner: vi.fn(),
      log: vi.fn(),
    } as unknown as InteractivePrompter;

    const result = await runManagementSession({
      action: "status",
      dependencies: deps,
      prompter,
      registry: { schemaVersion: 1, entries: [] },
      resolveExecutable: async () => undefined,
      snapshot: detected,
    });

    expect(result).toBe(0);
    expect(note).toHaveBeenCalledWith(
      "support-engine · Codex: missing-runtime (COMMAND_NOT_FOUND)",
      "Managed MCP installations",
    );
  });
});
