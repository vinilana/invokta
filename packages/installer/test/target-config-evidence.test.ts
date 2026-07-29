import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  InstallerFileSystem,
  InstallerPathInspection,
} from "../src/file-system.js";
import { createNodeFileSystem } from "../src/node-file-system.js";
import { configurationTargetIds } from "../src/registry.js";
import type { InstallerEnvironment } from "../src/target-config-evidence.js";
import { createNodeTargetConfigEvidenceProbes } from "../src/target-config-evidence.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryHome(): string {
  const directory = mkdtempSync(join(tmpdir(), "invokta-config-evidence-"));
  temporaryDirectories.push(directory);
  return directory;
}

function environment(
  values: Readonly<Record<string, unknown>> = {},
): InstallerEnvironment {
  return { get: (name) => values[name] };
}

function createConfig(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "{}\n");
}

function fileSystemWithInspection(
  inspectPath: InstallerFileSystem["inspectPath"],
): InstallerFileSystem {
  return {
    readFile: async () => new Uint8Array(),
    inspectPath,
  };
}

const defaultRelativePaths = {
  antigravity: ".gemini/config/mcp_config.json",
  "claude-code": ".claude.json",
  codex: ".codex/config.toml",
  cursor: ".cursor/mcp.json",
  "grok-build": ".grok/config.toml",
  hermes: ".hermes/config.yaml",
  "kimi-code": ".kimi-code/mcp.json",
  openclaw: ".openclaw/openclaw.json",
  "opencode-v2": ".config/opencode/opencode.json",
} as const;

describe("Node target configuration evidence probes", () => {
  it("rejects an intermediate symlink that escapes the injected home", async () => {
    const homeDirectory = temporaryHome();
    const outsideDirectory = temporaryHome();
    createConfig(join(outsideDirectory, "config.toml"));
    symlinkSync(outsideDirectory, join(homeDirectory, ".codex"), "dir");
    const probes = createNodeTargetConfigEvidenceProbes({
      environment: environment(),
      fileSystem: createNodeFileSystem(),
    });

    await expect(
      probes.codex({ homeDirectory, targetId: "codex" }),
    ).resolves.toEqual({
      kind: "blocked",
      code: "HARNESS_CONFIG_UNSAFE",
    });
  });

  it.each([
    {
      name: "a directory override",
      link: "overrides/codex",
      target: "actual-codex/config.toml",
      environment: (homeDirectory: string) => ({
        CODEX_HOME: join(homeDirectory, "overrides/codex"),
      }),
      probe: "codex" as const,
    },
    {
      name: "an OpenClaw candidate directory",
      link: ".openclaw",
      target: "actual-openclaw/openclaw.json",
      environment: () => ({}),
      probe: "openclaw" as const,
    },
    {
      name: "an OpenCode sibling directory",
      link: ".config/opencode",
      target: "actual-opencode/opencode.json",
      environment: () => ({}),
      probe: "opencode-v2" as const,
    },
  ])("rejects a within-home symlink in $name", async (fixture) => {
    const homeDirectory = temporaryHome();
    const targetPath = join(homeDirectory, fixture.target);
    createConfig(targetPath);
    const linkPath = join(homeDirectory, fixture.link);
    mkdirSync(dirname(linkPath), { recursive: true });
    symlinkSync(dirname(targetPath), linkPath, "dir");
    const probes = createNodeTargetConfigEvidenceProbes({
      environment: environment(fixture.environment(homeDirectory)),
      fileSystem: createNodeFileSystem(),
    });

    await expect(
      probes[fixture.probe]({
        homeDirectory,
        targetId: fixture.probe,
      }),
    ).resolves.toEqual({
      kind: "blocked",
      code: "HARNESS_CONFIG_UNSAFE",
    });
  });

  it("rejects a symlink at the final config-file component", async () => {
    const homeDirectory = temporaryHome();
    const actualConfig = join(homeDirectory, "actual-claude.json");
    createConfig(actualConfig);
    symlinkSync(actualConfig, join(homeDirectory, ".claude.json"), "file");
    const probes = createNodeTargetConfigEvidenceProbes({
      environment: environment(),
      fileSystem: createNodeFileSystem(),
    });

    await expect(
      probes["claude-code"]({
        homeDirectory,
        targetId: "claude-code",
      }),
    ).resolves.toEqual({
      kind: "blocked",
      code: "HARNESS_CONFIG_UNSAFE",
    });
  });

  it.each(["intermediate", "final"] as const)(
    "rejects a wrong-owner %s component from injected metadata",
    async (wrongOwnerComponent) => {
      const homeDirectory = "/users/tester";
      const directoryPath = join(homeDirectory, ".codex");
      const configPath = join(directoryPath, "config.toml");
      const wrongOwnerPath =
        wrongOwnerComponent === "intermediate" ? directoryPath : configPath;
      const inspectPath = vi.fn(
        async (path: string): Promise<InstallerPathInspection> => ({
          kind: path === configPath ? "regular-file" : "directory",
          ownerId: path === wrongOwnerPath ? 1001 : 1000,
          realPath: path,
        }),
      );
      const probes = createNodeTargetConfigEvidenceProbes({
        currentUserId: 1000,
        environment: environment(),
        fileSystem: fileSystemWithInspection(inspectPath),
      });

      await expect(
        probes.codex({ homeDirectory, targetId: "codex" }),
      ).resolves.toEqual({
        kind: "blocked",
        code: "HARNESS_CONFIG_UNSAFE",
      });
    },
  );

  it("rejects an injected canonical component path that escapes the real home", async () => {
    const homeDirectory = "/users/tester";
    const directoryPath = join(homeDirectory, ".codex");
    const inspectPath = vi.fn(
      async (path: string): Promise<InstallerPathInspection> => ({
        kind: "directory",
        ownerId: 1000,
        realPath:
          path === homeDirectory ? "/real-home/tester" : "/outside-home/.codex",
      }),
    );
    const probes = createNodeTargetConfigEvidenceProbes({
      currentUserId: 1000,
      environment: environment(),
      fileSystem: fileSystemWithInspection(inspectPath),
    });

    await expect(
      probes.codex({ homeDirectory, targetId: "codex" }),
    ).resolves.toEqual({
      kind: "blocked",
      code: "HARNESS_CONFIG_UNSAFE",
    });
    expect(inspectPath).toHaveBeenCalledWith(directoryPath);
  });

  it("treats a genuinely missing intermediate directory as absent", async () => {
    const homeDirectory = "/users/tester";
    const directoryPath = join(homeDirectory, ".codex");
    const configPath = join(directoryPath, "config.toml");
    const inspectPath = vi.fn(
      async (path: string): Promise<InstallerPathInspection> =>
        path === homeDirectory
          ? {
              kind: "directory",
              ownerId: 1000,
              realPath: homeDirectory,
            }
          : { kind: "missing" },
    );
    const probes = createNodeTargetConfigEvidenceProbes({
      currentUserId: 1000,
      environment: environment(),
      fileSystem: fileSystemWithInspection(inspectPath),
    });

    await expect(
      probes.codex({ homeDirectory, targetId: "codex" }),
    ).resolves.toEqual({ kind: "absent", path: configPath });
    expect(inspectPath.mock.calls).toEqual([[homeDirectory], [directoryPath]]);
  });

  it("rejects a non-directory intermediate component", async () => {
    const homeDirectory = temporaryHome();
    writeFileSync(join(homeDirectory, ".codex"), "not a directory\n");
    const probes = createNodeTargetConfigEvidenceProbes({
      environment: environment(),
      fileSystem: createNodeFileSystem(),
    });

    await expect(
      probes.codex({ homeDirectory, targetId: "codex" }),
    ).resolves.toEqual({
      kind: "blocked",
      code: "HARNESS_CONFIG_UNSAFE",
    });
  });

  it("reports all nine documented default user configs as present", async () => {
    const homeDirectory = temporaryHome();
    for (const relativePath of Object.values(defaultRelativePaths)) {
      createConfig(join(homeDirectory, relativePath));
    }
    const probes = createNodeTargetConfigEvidenceProbes({
      environment: environment(),
      fileSystem: createNodeFileSystem(),
    });

    for (const targetId of configurationTargetIds) {
      await expect(
        probes[targetId]({ homeDirectory, targetId }),
      ).resolves.toEqual({
        kind: "present",
        path: join(homeDirectory, defaultRelativePaths[targetId]),
      });
    }
  });

  it("reports the exact creation path for all nine absent default user configs", async () => {
    const homeDirectory = temporaryHome();
    const probes = createNodeTargetConfigEvidenceProbes({
      environment: environment(),
      fileSystem: createNodeFileSystem(),
    });

    for (const targetId of configurationTargetIds) {
      await expect(
        probes[targetId]({ homeDirectory, targetId }),
      ).resolves.toEqual({
        kind: "absent",
        path: join(homeDirectory, defaultRelativePaths[targetId]),
      });
    }
  });

  it("honors every documented directory or file override", async () => {
    const homeDirectory = temporaryHome();
    const overrideRoot = join(homeDirectory, "overrides");
    const values = {
      CLAUDE_CONFIG_DIR: join(overrideRoot, "claude"),
      CODEX_HOME: join(overrideRoot, "codex"),
      GROK_HOME: join(overrideRoot, "grok"),
      HERMES_HOME: join(overrideRoot, "hermes"),
      KIMI_CODE_HOME: join(overrideRoot, "kimi"),
      OPENCLAW_CONFIG_PATH: join(overrideRoot, "openclaw.json"),
      OPENCODE_CONFIG_DIR: join(overrideRoot, "opencode"),
    };
    const expected = {
      "claude-code": join(values.CLAUDE_CONFIG_DIR, ".claude.json"),
      codex: join(values.CODEX_HOME, "config.toml"),
      "grok-build": join(values.GROK_HOME, "config.toml"),
      hermes: join(values.HERMES_HOME, "config.yaml"),
      "kimi-code": join(values.KIMI_CODE_HOME, "mcp.json"),
      openclaw: values.OPENCLAW_CONFIG_PATH,
      "opencode-v2": join(values.OPENCODE_CONFIG_DIR, "opencode.json"),
    } as const;
    for (const path of Object.values(expected)) createConfig(path);
    const probes = createNodeTargetConfigEvidenceProbes({
      environment: environment(values),
      fileSystem: createNodeFileSystem(),
    });

    for (const [targetId, path] of Object.entries(expected)) {
      await expect(
        probes[targetId as keyof typeof expected]({
          homeDirectory,
          targetId: targetId as keyof typeof expected,
        }),
      ).resolves.toEqual({ kind: "present", path });
    }
  });

  it("preserves every documented override as the exact absent creation path", async () => {
    const homeDirectory = temporaryHome();
    const overrideRoot = join(homeDirectory, "overrides");
    const values = {
      CLAUDE_CONFIG_DIR: join(overrideRoot, "claude"),
      CODEX_HOME: join(overrideRoot, "codex"),
      GROK_HOME: join(overrideRoot, "grok"),
      HERMES_HOME: join(overrideRoot, "hermes"),
      KIMI_CODE_HOME: join(overrideRoot, "kimi"),
      OPENCLAW_CONFIG_PATH: join(overrideRoot, "openclaw.json"),
      OPENCODE_CONFIG_DIR: join(overrideRoot, "opencode"),
    };
    const expected = {
      "claude-code": join(values.CLAUDE_CONFIG_DIR, ".claude.json"),
      codex: join(values.CODEX_HOME, "config.toml"),
      "grok-build": join(values.GROK_HOME, "config.toml"),
      hermes: join(values.HERMES_HOME, "config.yaml"),
      "kimi-code": join(values.KIMI_CODE_HOME, "mcp.json"),
      openclaw: values.OPENCLAW_CONFIG_PATH,
      "opencode-v2": join(values.OPENCODE_CONFIG_DIR, "opencode.json"),
    } as const;
    const probes = createNodeTargetConfigEvidenceProbes({
      environment: environment(values),
      fileSystem: createNodeFileSystem(),
    });

    for (const [targetId, path] of Object.entries(expected)) {
      await expect(
        probes[targetId as keyof typeof expected]({
          homeDirectory,
          targetId: targetId as keyof typeof expected,
        }),
      ).resolves.toEqual({ kind: "absent", path });
    }
  });

  it("honors XDG_CONFIG_HOME when OpenCode has no direct directory override", async () => {
    const homeDirectory = temporaryHome();
    const xdgHome = join(homeDirectory, "xdg");
    const path = join(xdgHome, "opencode/opencode.jsonc");
    const absentPath = join(xdgHome, "opencode/opencode.json");
    createConfig(path);
    const probes = createNodeTargetConfigEvidenceProbes({
      environment: environment({ XDG_CONFIG_HOME: xdgHome }),
      fileSystem: createNodeFileSystem(),
    });

    await expect(
      probes["opencode-v2"]({ homeDirectory, targetId: "opencode-v2" }),
    ).resolves.toEqual({ kind: "present", path });

    rmSync(path);

    await expect(
      probes["opencode-v2"]({ homeDirectory, targetId: "opencode-v2" }),
    ).resolves.toEqual({ kind: "absent", path: absentPath });
  });

  it.each([
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "GROK_HOME",
    "HERMES_HOME",
    "KIMI_CODE_HOME",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_HOME",
    "OPENCLAW_STATE_DIR",
    "OPENCODE_CONFIG_DIR",
    "XDG_CONFIG_HOME",
  ])("fails closed on an invalid %s override", async (name) => {
    const homeDirectory = temporaryHome();
    const targetId = name.startsWith("OPENCLAW")
      ? "openclaw"
      : name === "OPENCODE_CONFIG_DIR" || name === "XDG_CONFIG_HOME"
        ? "opencode-v2"
        : name === "CLAUDE_CONFIG_DIR"
          ? "claude-code"
          : name === "CODEX_HOME"
            ? "codex"
            : name === "GROK_HOME"
              ? "grok-build"
              : name === "HERMES_HOME"
                ? "hermes"
                : "kimi-code";

    for (const value of [
      "",
      "relative/path",
      join(homeDirectory, "..", "outside-home"),
      "nul\0path",
      42,
    ]) {
      const probes = createNodeTargetConfigEvidenceProbes({
        environment: environment({ [name]: value }),
        fileSystem: createNodeFileSystem(),
      });
      await expect(
        probes[targetId]({ homeDirectory, targetId }),
      ).resolves.toEqual({
        kind: "blocked",
        code: "HARNESS_CONFIG_UNSAFE",
      });
    }
  });

  it("reports simultaneous OpenCode siblings as ambiguous without choosing one", async () => {
    const homeDirectory = temporaryHome();
    createConfig(join(homeDirectory, ".config/opencode/opencode.json"));
    createConfig(join(homeDirectory, ".config/opencode/opencode.jsonc"));
    const probes = createNodeTargetConfigEvidenceProbes({
      environment: environment(),
      fileSystem: createNodeFileSystem(),
    });

    await expect(
      probes["opencode-v2"]({ homeDirectory, targetId: "opencode-v2" }),
    ).resolves.toEqual({
      kind: "blocked",
      code: "HARNESS_CONFIG_AMBIGUOUS",
    });
  });

  it("reports a named OpenClaw profile as unsupported before inspecting paths", async () => {
    const homeDirectory = temporaryHome();
    const probes = createNodeTargetConfigEvidenceProbes({
      environment: environment({ OPENCLAW_PROFILE: "work" }),
      fileSystem: createNodeFileSystem(),
    });

    await expect(
      probes.openclaw({ homeDirectory, targetId: "openclaw" }),
    ).resolves.toEqual({ kind: "blocked", code: "TARGET_UNSUPPORTED" });
  });

  it("uses finite OpenClaw precedence without scanning or guessing", async () => {
    const homeDirectory = temporaryHome();
    const stateDirectory = join(homeDirectory, "openclaw-state");
    const legacyPath = join(stateDirectory, "clawdbot.json");
    const lowerPrecedencePath = join(homeDirectory, ".openclaw/openclaw.json");
    createConfig(legacyPath);
    createConfig(lowerPrecedencePath);
    const probes = createNodeTargetConfigEvidenceProbes({
      environment: environment({ OPENCLAW_STATE_DIR: stateDirectory }),
      fileSystem: createNodeFileSystem(),
    });

    await expect(
      probes.openclaw({ homeDirectory, targetId: "openclaw" }),
    ).resolves.toEqual({ kind: "present", path: legacyPath });
  });

  it.each([
    {
      name: "an explicit state directory",
      environment: (homeDirectory: string) => ({
        OPENCLAW_STATE_DIR: join(homeDirectory, "openclaw-state"),
      }),
      prepare: () => undefined,
      expected: (homeDirectory: string) =>
        join(homeDirectory, "openclaw-state/openclaw.json"),
    },
    {
      name: "an existing .openclaw directory",
      environment: () => ({}),
      prepare: (homeDirectory: string) =>
        mkdirSync(join(homeDirectory, ".openclaw"), { recursive: true }),
      expected: (homeDirectory: string) =>
        join(homeDirectory, ".openclaw/openclaw.json"),
    },
    {
      name: "an existing legacy .clawdbot directory",
      environment: () => ({}),
      prepare: (homeDirectory: string) =>
        mkdirSync(join(homeDirectory, ".clawdbot"), { recursive: true }),
      expected: (homeDirectory: string) =>
        join(homeDirectory, ".clawdbot/openclaw.json"),
    },
    {
      name: "an effective OpenClaw home",
      environment: (homeDirectory: string) => ({
        OPENCLAW_HOME: join(homeDirectory, "openclaw-home"),
      }),
      prepare: (homeDirectory: string) =>
        mkdirSync(join(homeDirectory, "openclaw-home"), { recursive: true }),
      expected: (homeDirectory: string) =>
        join(homeDirectory, "openclaw-home/.openclaw/openclaw.json"),
    },
    {
      name: "the preferred directory when both standard directories exist",
      environment: () => ({}),
      prepare: (homeDirectory: string) => {
        mkdirSync(join(homeDirectory, ".openclaw"), { recursive: true });
        mkdirSync(join(homeDirectory, ".clawdbot"), { recursive: true });
      },
      expected: (homeDirectory: string) =>
        join(homeDirectory, ".openclaw/openclaw.json"),
    },
  ])("selects the exact absent OpenClaw path from $name", async (fixture) => {
    const homeDirectory = temporaryHome();
    fixture.prepare(homeDirectory);
    const probes = createNodeTargetConfigEvidenceProbes({
      environment: environment(fixture.environment(homeDirectory)),
      fileSystem: createNodeFileSystem(),
    });

    await expect(
      probes.openclaw({ homeDirectory, targetId: "openclaw" }),
    ).resolves.toEqual({
      kind: "absent",
      path: fixture.expected(homeDirectory),
    });
  });

  it("expands OpenClaw tilde paths against its validated effective home", async () => {
    const homeDirectory = temporaryHome();
    const effectiveHome = join(homeDirectory, "openclaw-home");
    const path = join(effectiveHome, "profiles/openclaw.json");
    createConfig(path);
    const probes = createNodeTargetConfigEvidenceProbes({
      environment: environment({
        OPENCLAW_HOME: effectiveHome,
        OPENCLAW_CONFIG_PATH: "~/profiles/openclaw.json",
      }),
      fileSystem: createNodeFileSystem(),
    });

    await expect(
      probes.openclaw({ homeDirectory, targetId: "openclaw" }),
    ).resolves.toEqual({ kind: "present", path });
  });

  it("reports absent files and contains filesystem read failures behind a stable target code", async () => {
    const homeDirectory = temporaryHome();
    const absentProbes = createNodeTargetConfigEvidenceProbes({
      environment: environment(),
      fileSystem: createNodeFileSystem(),
    });

    await expect(
      absentProbes.codex({ homeDirectory, targetId: "codex" }),
    ).resolves.toEqual({
      kind: "absent",
      path: join(homeDirectory, ".codex/config.toml"),
    });

    const failedProbes = createNodeTargetConfigEvidenceProbes({
      environment: environment(),
      fileSystem: {
        readFile: async () => new Uint8Array(),
        inspectPath: async () => Promise.reject(new Error("private path")),
      },
    });
    await expect(
      failedProbes.codex({ homeDirectory, targetId: "codex" }),
    ).resolves.toEqual({
      kind: "blocked",
      code: "HARNESS_CONFIG_READ_FAILED",
    });
  });

  it("rechecks vanished OpenCode sibling evidence through the same probe", async () => {
    const homeDirectory = temporaryHome();
    const jsonPath = join(homeDirectory, ".config/opencode/opencode.json");
    const jsoncPath = join(homeDirectory, ".config/opencode/opencode.jsonc");
    createConfig(jsoncPath);
    const probes = createNodeTargetConfigEvidenceProbes({
      environment: environment(),
      fileSystem: createNodeFileSystem(),
    });
    const probe = probes["opencode-v2"];

    await expect(
      probe({ homeDirectory, targetId: "opencode-v2" }),
    ).resolves.toEqual({ kind: "present", path: jsoncPath });

    rmSync(jsoncPath);

    await expect(
      probe({ homeDirectory, targetId: "opencode-v2" }),
    ).resolves.toEqual({ kind: "absent", path: jsonPath });
  });
});
