import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { HarnessDetectionSnapshot } from "../src/harness-detection.js";
import {
  installDescriptorAcrossTargets,
  type MutationCoordinatorDependencies,
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
    ) as { readonly installations: Readonly<Record<string, unknown>> };
    expect(Object.keys(state.installations)).toHaveLength(2);
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
});
