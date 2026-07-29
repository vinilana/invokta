import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { TargetConfigEvidenceProbes } from "../src/harness-detection.js";
import type { InteractivePrompter } from "../src/interactive-prompter.js";
import { runInteractiveSession } from "../src/interactive-session.js";
import type { RegistryCompatibilityAdapters } from "../src/registry.js";
import { configurationTargetIds } from "../src/registry.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function compatibilityAdapters(): RegistryCompatibilityAdapters {
  return Object.fromEntries(
    configurationTargetIds.map((targetId) => [
      targetId,
      () => ({ supported: true }) as const,
    ]),
  ) as unknown as RegistryCompatibilityAdapters;
}

function absentConfigProbes(events: string[]): TargetConfigEvidenceProbes {
  return Object.fromEntries(
    configurationTargetIds.map((targetId) => [
      targetId,
      async ({ homeDirectory }: { readonly homeDirectory: string }) => {
        events.push(`config:${targetId}`);
        return {
          kind: "absent",
          path: join(homeDirectory, ".fixture-config", targetId),
        } as const;
      },
    ]),
  ) as unknown as TargetConfigEvidenceProbes;
}

describe("interactive detection session", () => {
  it("loads the empty registry, captures one read-only snapshot, and dismisses without mutation", async () => {
    const events: string[] = [];
    const note = vi.fn();
    let selectionPrompt: unknown;
    const select = vi.fn(async (prompt: unknown) => {
      selectionPrompt = prompt;
      return {
        kind: "submitted" as const,
        value: "dismiss",
      };
    });
    const spinner = {
      start: vi.fn((message?: string) => events.push(`start:${message}`)),
      stop: vi.fn((message?: string) => events.push(`stop:${message}`)),
      cancel: vi.fn(),
      error: vi.fn(),
      message: vi.fn(),
      clear: vi.fn(),
    };
    const prompter: InteractivePrompter = {
      intro: vi.fn((title) => events.push(`intro:${title}`)),
      outro: vi.fn(),
      cancel: vi.fn(),
      autocomplete: vi.fn(),
      select: select as unknown as InteractivePrompter["select"],
      multiselect: vi.fn(),
      note,
      confirm: vi.fn(),
      spinner: vi.fn(() => spinner),
      log: vi.fn(),
    };
    const emptyRegistry = new TextEncoder().encode(
      '{"schemaVersion":1,"entries":[]}',
    );

    const exitCode = await runInteractiveSession({
      prompter,
      fileSystem: {
        readFile: vi.fn(async () => {
          events.push("registry");
          return emptyRegistry;
        }),
        inspectPath: vi.fn(async () => ({ kind: "missing" }) as const),
      },
      compatibilityAdapters: compatibilityAdapters(),
      resolveHomeDirectory: vi.fn(() => {
        events.push("home");
        return "/users/tester";
      }),
      resolveExecutable: vi.fn(async (candidate) => {
        events.push(`executable:${candidate}`);
        return candidate === "codex"
          ? {
              path: "/fixture/bin/codex",
              identity: {
                device: 7,
                inode: 31,
                realPath: "/fixture/bin/codex",
              },
            }
          : undefined;
      }),
      configEvidenceProbes: absentConfigProbes(events),
    });

    expect(exitCode).toBe(0);
    expect(events[0]).toBe("intro:Invokta capability installer");
    expect(events[1]).toBe("start:Detecting supported AI harnesses");
    expect(events[2]).toBe("registry");
    expect(events.indexOf("home")).toBeGreaterThan(events.indexOf("registry"));
    expect(events.at(-1)).toBe("stop:Harness detection complete");
    expect(note).toHaveBeenCalledWith(
      "1 supported configuration target detected.",
      "Harness inventory",
    );
    expect(selectionPrompt).toMatchObject({
      options: [
        { value: "codex", label: "Codex", hint: "installed" },
        { value: "dismiss", label: "Done" },
      ],
    });
    expect(spinner.error).not.toHaveBeenCalled();
  });

  it("uses the production config probes to inventory all eleven config-only targets", async () => {
    const homeDirectory = mkdtempSync(
      join(tmpdir(), "invokta-interactive-configs-"),
    );
    temporaryDirectories.push(homeDirectory);
    for (const relativePath of [
      ".gemini/config/mcp_config.json",
      ".claude.json",
      "Library/Application Support/Claude/claude_desktop_config.json",
      ".codex/config.toml",
      ".cursor/mcp.json",
      ".grok/config.toml",
      ".hermes/config.yaml",
      ".kimi-code/mcp.json",
      ".openclaw/openclaw.json",
      ".config/opencode/opencode.json",
      "Library/Application Support/Code/User/mcp.json",
    ]) {
      const path = join(homeDirectory, relativePath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "{}\n");
    }
    let selectionPrompt: unknown;
    const select = vi.fn(async (prompt: unknown) => {
      selectionPrompt = prompt;
      return { kind: "submitted" as const, value: "dismiss" };
    });
    const prompter: InteractivePrompter = {
      intro: vi.fn(),
      outro: vi.fn(),
      cancel: vi.fn(),
      autocomplete: vi.fn(),
      select: select as unknown as InteractivePrompter["select"],
      multiselect: vi.fn(),
      note: vi.fn(),
      confirm: vi.fn(),
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

    const exitCode = await runInteractiveSession({
      prompter,
      environment: { get: () => undefined },
      platform: "darwin",
      resolveHomeDirectory: () => homeDirectory,
      resolveExecutable: async () => undefined,
    });

    expect(exitCode).toBe(0);
    expect(selectionPrompt).toMatchObject({
      options: [
        ...configurationTargetIds.map((value) => ({
          value,
          hint: "configuration-only",
        })),
        { value: "dismiss", label: "Done" },
      ],
    });
  });
});
