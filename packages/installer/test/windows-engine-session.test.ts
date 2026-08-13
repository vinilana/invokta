import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExecutableResolver } from "../src/harness-detection.js";
import type { InteractivePrompter } from "../src/interactive-prompter.js";
import { runInteractiveSession } from "../src/interactive-session.js";
import { createNodeFileSystem } from "../src/node-file-system.js";
import { createNodeTargetConfigEvidenceProbes } from "../src/target-config-evidence.js";
import {
  createWindowsLikeFileSystem,
  windowsPrincipal,
} from "./windows-file-system.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function createGlobalEnginePackage(): string {
  const globalRoot = temporaryDirectory("invokta-windows-npm-global-");
  const packageDirectory = join(globalRoot, "node_modules/small-brain");
  mkdirSync(join(packageDirectory, "dist"), { recursive: true });
  writeFileSync(join(packageDirectory, "dist/mcp-stdio.js"), "export {};\n");
  writeFileSync(
    join(packageDirectory, "invokta.mcp.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "small-brain",
      version: "0.1.1",
      title: "Small Brain",
      description: "Example engine installed from the global npm root.",
      capabilityIds: ["memory.recall"],
      server: {
        name: "small-brain",
        entrypoint: "dist/mcp-stdio.js",
        forwardEnv: [],
      },
    }),
  );
  return packageDirectory;
}

function scriptedPrompter(): InteractivePrompter {
  return {
    intro: vi.fn(),
    outro: vi.fn(),
    cancel: vi.fn(),
    autocomplete: vi.fn(),
    select: vi.fn(),
    multiselect: vi.fn(
      async (prompt: { readonly initialValues?: readonly string[] }) => ({
        kind: "submitted" as const,
        value: [...(prompt.initialValues ?? [])],
      }),
    ) as unknown as InteractivePrompter["multiselect"],
    note: vi.fn(),
    confirm: vi.fn(async () => ({ kind: "submitted" as const, value: true })),
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

describe("Windows principal engine session", () => {
  it("installs and removes a global npm engine through the Windows-like file system", async () => {
    const homeDirectory = temporaryDirectory("invokta-windows-home-");
    const configPath = join(homeDirectory, ".codex/config.toml");
    mkdirSync(join(homeDirectory, ".codex"));
    writeFileSync(configPath, "");
    const projectDirectory = createGlobalEnginePackage();
    const fileSystem = createWindowsLikeFileSystem(
      createNodeFileSystem({ ownership: windowsPrincipal }),
    );
    const environment = { get: () => undefined };
    const configEvidenceProbes = createNodeTargetConfigEvidenceProbes({
      ownership: windowsPrincipal,
      platform: "win32",
      environment,
      fileSystem,
    });
    const resolveExecutable: ExecutableResolver = async (candidate) =>
      candidate === process.execPath
        ? {
            path: process.execPath,
            identity: { device: 1, inode: 1, realPath: process.execPath },
          }
        : undefined;
    const sessionOptions = {
      ownership: windowsPrincipal,
      fileSystem,
      transactionFileSystem: fileSystem,
      environment,
      resolveHomeDirectory: () => homeDirectory,
      resolveExecutable,
      configEvidenceProbes,
    };

    const installPrompter = scriptedPrompter();
    const installExit = await runInteractiveSession({
      ...sessionOptions,
      command: { kind: "install-engine", projectDirectory },
      prompter: installPrompter,
    });

    expect(installExit).toBe(0);
    expect(installPrompter.outro).toHaveBeenCalledWith(
      "Action Engine installed. Restart or reload the selected MCP clients.",
    );
    const installedConfig = readFileSync(configPath, "utf8");
    expect(installedConfig).toContain("small-brain");
    expect(installedConfig).toContain(
      join(projectDirectory, "dist/mcp-stdio.js"),
    );
    const statePath = join(
      homeDirectory,
      ".local/state/invokta/installer.json",
    );
    const installedState = JSON.parse(readFileSync(statePath, "utf8")) as {
      installations: Record<string, { entryId: string }>;
    };
    expect(Object.values(installedState.installations)).toMatchObject([
      { entryId: "small-brain" },
    ]);

    const removalPrompter = scriptedPrompter();
    const removalExit = await runInteractiveSession({
      ...sessionOptions,
      command: { kind: "remove-engine", projectDirectory },
      prompter: removalPrompter,
    });

    expect(removalExit).toBe(0);
    expect(readFileSync(configPath, "utf8")).not.toContain("small-brain");
    const removedState = JSON.parse(readFileSync(statePath, "utf8")) as {
      installations: Record<string, unknown>;
    };
    expect(removedState.installations).toEqual({});
  });
});
