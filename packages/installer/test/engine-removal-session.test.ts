import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CapabilityInstallDescriptor,
  EngineRemovalSource,
  HarnessDetectionSnapshot,
} from "@invokta/client-config";
import {
  configurationTargetAdapters,
  createNodeFileSystem,
  installDescriptorAcrossTargets,
  type MutationCoordinatorDependencies,
  mutateDescriptorAcrossTargets,
} from "@invokta/client-config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runEngineRemovalSession } from "../src/engine-removal-session.js";
import type { InteractivePrompter } from "../src/interactive-prompter.js";

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
    evidence: "configuration-only",
    executables: [],
    configuration: { kind: "present", path },
    eligible: true,
    mayCreateConfiguration: false,
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

function descriptor(
  options: { readonly id?: string; readonly serverName?: string } = {},
): CapabilityInstallDescriptor {
  const id = options.id ?? "support-engine";
  const serverName = options.serverName ?? "support-engine";
  return {
    id,
    version: "1.0.0",
    title: "Support Engine",
    description: "Support actions.",
    capabilityIds: ["tickets.summarize"],
    server: {
      name: serverName,
      transport: {
        type: "stdio",
        command: process.execPath,
        args: ["/workspace/support-engine/dist/mcp-stdio.js"],
        forwardEnv: [],
      },
    },
  };
}

function source(
  options: {
    readonly id?: string;
    readonly serverName?: string;
    readonly title?: string;
  } = {},
): EngineRemovalSource {
  return Object.freeze({
    manifestPath: "/workspace/support-engine/invokta.mcp.json",
    id: options.id ?? "support-engine",
    title: options.title ?? "Support Engine",
    serverName: options.serverName ?? "support-engine",
  });
}

function dependencies(): MutationCoordinatorDependencies {
  let wallTime = Date.parse("2026-07-30T12:00:00.000Z");
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
      processId: 321,
      randomBytes: (length) => {
        token += 1;
        return new Uint8Array(length).fill(token);
      },
    },
    now: () => new Date(wallTime).toISOString(),
  };
}

function prompter(
  confirmation: boolean | "cancelled" = true,
): InteractivePrompter {
  return {
    intro: vi.fn(),
    outro: vi.fn(),
    cancel: vi.fn(),
    autocomplete: vi.fn(),
    select: vi.fn(),
    multiselect: vi.fn(),
    note: vi.fn(),
    confirm: vi.fn(async () =>
      confirmation === "cancelled"
        ? ({ kind: "cancelled" as const } as const)
        : ({ kind: "submitted" as const, value: confirmation } as const),
    ),
    spinner: vi.fn(() => ({
      start: vi.fn(),
      stop: vi.fn(),
      cancel: vi.fn(),
      error: vi.fn(),
      message: vi.fn(),
      clear: vi.fn(),
    })),
    log: vi.fn(),
  };
}

function statePath(homeDirectory: string): string {
  return join(homeDirectory, ".local/state/invokta/installer.json");
}

describe("runEngineRemovalSession", () => {
  it("removes every matching owned target after one confirmation", async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "invokta-remove-engine-"));
    temporaryDirectories.push(homeDirectory);
    const detected = snapshot(homeDirectory);
    const deps = dependencies();
    await installDescriptorAcrossTargets({
      dependencies: deps,
      descriptor: descriptor(),
      snapshot: detected,
      targetIds: ["codex", "cursor"],
    });
    const prompts = prompter();

    const result = await runEngineRemovalSession({
      dependencies: deps,
      prompter: prompts,
      snapshot: detected,
      source: source(),
    });

    expect(result).toBe(0);
    expect(prompts.note).toHaveBeenCalledWith(
      "support-engine · Codex: removable\nsupport-engine · Cursor: removable",
      "Engine uninstall preflight",
    );
    expect(prompts.confirm).toHaveBeenCalledTimes(1);
    expect(prompts.confirm).toHaveBeenCalledWith(
      "Remove Support Engine from 2 MCP client configurations?",
    );
    expect(
      readFileSync(join(homeDirectory, ".codex/config.toml"), "utf8"),
    ).not.toContain("support-engine");
    expect(
      readFileSync(join(homeDirectory, ".cursor/mcp.json"), "utf8"),
    ).not.toContain("support-engine");
    const state = JSON.parse(
      readFileSync(statePath(homeDirectory), "utf8"),
    ) as {
      readonly installations: Readonly<Record<string, unknown>>;
    };
    expect(state.installations).toEqual({});
  });

  it("returns an idempotent no-op without confirmation when no identity matches", async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "invokta-remove-engine-"));
    temporaryDirectories.push(homeDirectory);
    const prompts = prompter();

    const result = await runEngineRemovalSession({
      dependencies: dependencies(),
      prompter: prompts,
      snapshot: snapshot(homeDirectory),
      source: source(),
    });

    expect(result).toBe(0);
    expect(prompts.confirm).not.toHaveBeenCalled();
    expect(prompts.outro).toHaveBeenCalledWith(
      "Support Engine is already uninstalled.",
    );
  });

  it.each([
    [false, 0],
    ["cancelled", 130],
  ] as const)(
    "keeps every target unchanged when confirmation resolves as %s",
    async (confirmation, expectedExit) => {
      const homeDirectory = mkdtempSync(
        join(tmpdir(), "invokta-remove-engine-"),
      );
      temporaryDirectories.push(homeDirectory);
      const detected = snapshot(homeDirectory);
      const deps = dependencies();
      await installDescriptorAcrossTargets({
        dependencies: deps,
        descriptor: descriptor(),
        snapshot: detected,
        targetIds: ["codex"],
      });
      const beforeConfig = readFileSync(
        join(homeDirectory, ".codex/config.toml"),
        "utf8",
      );
      const beforeState = readFileSync(statePath(homeDirectory), "utf8");
      const prompts = prompter(confirmation);

      const result = await runEngineRemovalSession({
        dependencies: deps,
        prompter: prompts,
        snapshot: detected,
        source: source(),
      });

      expect(result).toBe(expectedExit);
      expect(
        readFileSync(join(homeDirectory, ".codex/config.toml"), "utf8"),
      ).toBe(beforeConfig);
      expect(readFileSync(statePath(homeDirectory), "utf8")).toBe(beforeState);
      if (confirmation === "cancelled") {
        expect(prompts.cancel).toHaveBeenCalledWith(
          "Installation was cancelled.",
        );
      }
    },
  );

  it("uses persisted identity metadata after manifest metadata changes", async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "invokta-remove-engine-"));
    temporaryDirectories.push(homeDirectory);
    const detected = snapshot(homeDirectory);
    const deps = dependencies();
    await installDescriptorAcrossTargets({
      dependencies: deps,
      descriptor: descriptor({ serverName: "persisted-support" }),
      snapshot: detected,
      targetIds: ["codex"],
    });

    const result = await runEngineRemovalSession({
      dependencies: deps,
      prompter: prompter(),
      snapshot: detected,
      source: source({
        serverName: "renamed-support",
        title: "Renamed Support Engine",
      }),
    });

    expect(result).toBe(0);
    expect(
      readFileSync(join(homeDirectory, ".codex/config.toml"), "utf8"),
    ).not.toContain("persisted-support");
  });

  it("fails the global preflight for a server-name identity mismatch", async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "invokta-remove-engine-"));
    temporaryDirectories.push(homeDirectory);
    const detected = snapshot(homeDirectory);
    const deps = dependencies();
    await installDescriptorAcrossTargets({
      dependencies: deps,
      descriptor: descriptor({ id: "different-engine" }),
      snapshot: detected,
      targetIds: ["codex"],
    });
    const prompts = prompter();

    await expect(
      runEngineRemovalSession({
        dependencies: deps,
        prompter: prompts,
        snapshot: detected,
        source: source(),
      }),
    ).rejects.toMatchObject({ code: "ENGINE_IDENTITY_MISMATCH" });
    expect(prompts.confirm).not.toHaveBeenCalled();
    expect(
      readFileSync(join(homeDirectory, ".codex/config.toml"), "utf8"),
    ).toContain("support-engine");
  });

  it("fails a mixed-identity state before removing an exact match", async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "invokta-remove-engine-"));
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
      descriptor: descriptor({ id: "different-engine" }),
      snapshot: detected,
      targetIds: ["cursor"],
    });
    const prompts = prompter();

    await expect(
      runEngineRemovalSession({
        dependencies: deps,
        prompter: prompts,
        snapshot: detected,
        source: source(),
      }),
    ).rejects.toMatchObject({ code: "ENGINE_IDENTITY_MISMATCH" });
    expect(prompts.confirm).not.toHaveBeenCalled();
    expect(
      readFileSync(join(homeDirectory, ".codex/config.toml"), "utf8"),
    ).toContain("support-engine");
  });

  it("does not confirm or mutate an all-blocked legacy set", async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "invokta-remove-engine-"));
    temporaryDirectories.push(homeDirectory);
    const detected = snapshot(homeDirectory);
    const deps = dependencies();
    await installDescriptorAcrossTargets({
      dependencies: deps,
      descriptor: descriptor(),
      snapshot: detected,
      targetIds: ["codex"],
    });
    const path = statePath(homeDirectory);
    const state = JSON.parse(readFileSync(path, "utf8")) as {
      installations: Record<string, { launchDescriptor?: unknown }>;
    };
    for (const installation of Object.values(state.installations)) {
      delete installation.launchDescriptor;
    }
    writeFileSync(path, `${JSON.stringify(state)}\n`);
    const prompts = prompter();

    const result = await runEngineRemovalSession({
      dependencies: deps,
      prompter: prompts,
      snapshot: detected,
      source: source(),
    });

    expect(result).toBe(1);
    expect(prompts.confirm).not.toHaveBeenCalled();
    expect(prompts.log).toHaveBeenCalledWith(
      "error",
      "Codex: INSTALLATION_UNAVAILABLE: The managed installation is unavailable.",
    );
    expect(
      readFileSync(join(homeDirectory, ".codex/config.toml"), "utf8"),
    ).toContain("support-engine");
  });

  it("commits removable targets while leaving a drifted target unchanged", async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "invokta-remove-engine-"));
    temporaryDirectories.push(homeDirectory);
    const detected = snapshot(homeDirectory);
    const deps = dependencies();
    await installDescriptorAcrossTargets({
      dependencies: deps,
      descriptor: descriptor(),
      snapshot: detected,
      targetIds: ["codex", "cursor"],
    });
    const cursorPath = join(homeDirectory, ".cursor/mcp.json");
    const cursor = JSON.parse(readFileSync(cursorPath, "utf8")) as {
      mcpServers: Record<string, { args: string[] }>;
    };
    cursor.mcpServers["support-engine"]?.args.push("--external-change");
    writeFileSync(cursorPath, `${JSON.stringify(cursor)}\n`);
    const prompts = prompter();

    const result = await runEngineRemovalSession({
      dependencies: deps,
      prompter: prompts,
      snapshot: detected,
      source: source(),
    });

    expect(result).toBe(1);
    expect(prompts.confirm).toHaveBeenCalledTimes(1);
    expect(
      readFileSync(join(homeDirectory, ".codex/config.toml"), "utf8"),
    ).not.toContain("support-engine");
    expect(readFileSync(cursorPath, "utf8")).toContain("--external-change");
    expect(prompts.log).toHaveBeenCalledWith(
      "error",
      "Cursor: CONFIG_DRIFT: The managed MCP server was changed outside the installer.",
    );
  });

  it("commits an independent target when another config path relocated", async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "invokta-remove-engine-"));
    temporaryDirectories.push(homeDirectory);
    const installedSnapshot = snapshot(homeDirectory);
    const deps = dependencies();
    await installDescriptorAcrossTargets({
      dependencies: deps,
      descriptor: descriptor(),
      snapshot: installedSnapshot,
      targetIds: ["codex", "cursor"],
    });
    const codex = installedSnapshot.targets[0];
    const cursor = installedSnapshot.targets[1];
    if (codex === undefined || cursor === undefined) throw new Error("fixture");
    const relocatedSnapshot = {
      ...installedSnapshot,
      targets: [
        codex,
        {
          ...cursor,
          configuration: {
            kind: "present" as const,
            path: join(homeDirectory, ".cursor-relocated/mcp.json"),
          },
        },
      ],
    };
    const prompts = prompter();

    const result = await runEngineRemovalSession({
      dependencies: deps,
      prompter: prompts,
      snapshot: relocatedSnapshot,
      source: source(),
    });

    expect(result).toBe(1);
    expect(
      readFileSync(join(homeDirectory, ".codex/config.toml"), "utf8"),
    ).not.toContain("support-engine");
    expect(
      readFileSync(join(homeDirectory, ".cursor/mcp.json"), "utf8"),
    ).toContain("support-engine");
    expect(prompts.log).toHaveBeenCalledWith(
      "error",
      "Cursor: HARNESS_CONFIG_UNSAFE: The harness configuration path is unsafe.",
    );
  });

  it("removes detached-disabled state without restoring its definition", async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "invokta-remove-engine-"));
    temporaryDirectories.push(homeDirectory);
    const detected = snapshot(homeDirectory);
    const deps = dependencies();
    await installDescriptorAcrossTargets({
      dependencies: deps,
      descriptor: descriptor(),
      snapshot: detected,
      targetIds: ["cursor"],
    });
    await mutateDescriptorAcrossTargets({
      action: "disable",
      dependencies: deps,
      descriptor: descriptor(),
      snapshot: detected,
      targetIds: ["cursor"],
    });

    const result = await runEngineRemovalSession({
      dependencies: deps,
      prompter: prompter(),
      snapshot: detected,
      source: source(),
    });

    expect(result).toBe(0);
    expect(
      JSON.parse(readFileSync(join(homeDirectory, ".cursor/mcp.json"), "utf8")),
    ).toEqual({ mcpServers: {} });
    const state = JSON.parse(
      readFileSync(statePath(homeDirectory), "utf8"),
    ) as {
      readonly installations: Readonly<Record<string, unknown>>;
    };
    expect(state.installations).toEqual({});
  });
});
