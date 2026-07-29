import { describe, expect, it, vi } from "vitest";

import type { HarnessDetectionSnapshot } from "../src/harness-detection.js";
import { runInstallSession } from "../src/install-session.js";
import type { InteractivePrompter } from "../src/interactive-prompter.js";
import { createNodeFileSystem } from "../src/node-file-system.js";
import type { CapabilityInstallDescriptor } from "../src/registry.js";
import { configurationTargetAdapters } from "../src/target-adapters.js";

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
        args: ["/workspace/support/dist/mcp-stdio.js"],
        forwardEnv: [],
      },
    },
  };
}

describe("interactive install session", () => {
  it("preselects every compatible eligible target and uses one confirmation", async () => {
    let multiselectPrompt: unknown;
    const confirm = vi.fn(async () => ({
      kind: "submitted" as const,
      value: false,
    }));
    const prompter: InteractivePrompter = {
      intro: vi.fn(),
      outro: vi.fn(),
      cancel: vi.fn(),
      autocomplete: vi.fn(),
      select: vi.fn(),
      multiselect: vi.fn(async (prompt) => {
        multiselectPrompt = prompt;
        return {
          kind: "submitted" as const,
          value: ["codex", "cursor"] as const,
        };
      }) as InteractivePrompter["multiselect"],
      note: vi.fn(),
      confirm,
      spinner: vi.fn(),
      log: vi.fn(),
    };
    const snapshot: HarnessDetectionSnapshot = {
      homeDirectory: "/users/tester",
      surfaces: [],
      targets: [
        {
          id: "codex",
          displayName: "Codex",
          surfaceIds: [],
          evidence: "installed",
          executables: [],
          configuration: {
            kind: "absent",
            path: "/users/tester/.codex/config.toml",
          },
          eligible: true,
          mayCreateConfiguration: true,
          reloadHint: "Reload Codex.",
        },
        {
          id: "cursor",
          displayName: "Cursor",
          surfaceIds: [],
          evidence: "configuration-only",
          executables: [],
          configuration: {
            kind: "present",
            path: "/users/tester/.cursor/mcp.json",
          },
          eligible: true,
          mayCreateConfiguration: false,
          reloadHint: "Reload Cursor.",
        },
      ],
    };

    const result = await runInstallSession({
      dependencies: {
        adapters: configurationTargetAdapters,
        currentUserId: 1,
        environment: { get: () => undefined },
        fileSystem: createNodeFileSystem(),
        lock: {
          clock: {
            monotonicNow: () => 0,
            now: () => 0,
            wait: async () => undefined,
          },
          processId: 1,
          randomBytes: (length) => new Uint8Array(length),
        },
        now: () => "2026-07-29T12:00:00.000Z",
      },
      descriptor: descriptor(),
      prompter,
      resolveExecutable: async (candidate) => ({
        path: candidate,
        identity: { device: 1, inode: 2, realPath: candidate },
      }),
      snapshot,
    });

    expect(result).toBe(0);
    expect(multiselectPrompt).toMatchObject({
      initialValues: ["codex", "cursor"],
      options: [
        { value: "codex", label: "Codex" },
        { value: "cursor", label: "Cursor" },
      ],
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(prompter.outro).toHaveBeenCalledWith("No changes were made.");
  });
});
