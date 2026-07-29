import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const fixtureDirectory = fileURLToPath(new URL("./fixtures", import.meta.url));
const temporaryRoot = mkdtempSync(join(tmpdir(), "invokta-surfaces-"));
const executableDirectory = join(temporaryRoot, "bin");
const emptyExecutableDirectory = join(temporaryRoot, "empty-bin");
const homeWithoutConfigs = join(temporaryRoot, "home-without-configs");
const homeWithConfigs = join(temporaryRoot, "home-with-configs");
const marker = join(temporaryRoot, "invoked.marker");

const defaultConfigPaths = [
  ".gemini/config/mcp_config.json",
  ".claude.json",
  ".codex/config.toml",
  ".cursor/mcp.json",
  ".grok/config.toml",
  ".hermes/config.yaml",
  ".kimi-code/mcp.json",
  ".openclaw/openclaw.json",
  ".config/opencode/opencode.json",
] as const;

beforeAll(() => {
  execFileSync(
    process.execPath,
    [
      "node_modules/typescript/bin/tsc",
      "-b",
      "packages/installer",
      "--pretty",
      "false",
    ],
    { cwd: repositoryRoot, stdio: "pipe" },
  );
  mkdirSync(executableDirectory);
  mkdirSync(emptyExecutableDirectory);
  mkdirSync(homeWithoutConfigs);
  mkdirSync(homeWithConfigs);
  for (const relativePath of defaultConfigPaths) {
    const path = join(homeWithConfigs, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{}\n");
  }
  for (const candidate of [
    "agy",
    "antigravity",
    "claude",
    "codex",
    "cursor",
    "grok",
    "hermes",
    "kimi",
    "openclaw",
    "opencode2",
  ]) {
    const path = join(executableDirectory, candidate);
    writeFileSync(
      path,
      `#!/bin/sh\nprintf invoked > ${JSON.stringify(marker)}\nexit 97\n`,
    );
    chmodSync(path, 0o755);
  }
});

afterAll(() => {
  rmSync(temporaryRoot, { force: true, recursive: true });
});

describe("harness detection safety sentinels", () => {
  function runScenario(pathValue: string, homeDirectory: string) {
    const environment = { ...process.env };
    for (const name of [
      "CLAUDE_CONFIG_DIR",
      "CODEX_HOME",
      "GROK_HOME",
      "HERMES_HOME",
      "KIMI_CODE_HOME",
      "OPENCLAW_CONFIG_PATH",
      "OPENCLAW_HOME",
      "OPENCLAW_PROFILE",
      "OPENCLAW_STATE_DIR",
      "OPENCODE_CONFIG_DIR",
      "XDG_CONFIG_HOME",
    ]) {
      delete environment[name];
    }
    return spawnSync(
      process.execPath,
      [
        "--import",
        join(fixtureDirectory, "forbid-process-execution.mjs"),
        "--import",
        join(fixtureDirectory, "forbid-network-access.mjs"),
        "--import",
        join(fixtureDirectory, "forbid-filesystem-writes.mjs"),
        join(fixtureDirectory, "detection-sentinel-scenario.mjs"),
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ...environment,
          INVOKTA_INSTALLER_TEST_HOME: homeDirectory,
          PATH: pathValue,
        },
      },
    );
  }

  it("detects all ten surfaces while process, network, and filesystem writes are forbidden", () => {
    const result = runScenario(executableDirectory, homeWithoutConfigs);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      installedSurfaces: [
        "antigravity-cli",
        "antigravity-ide",
        "claude-code",
        "codex",
        "cursor",
        "grok-build",
        "hermes",
        "kimi-code",
        "openclaw",
        "opencode-v2",
      ],
      eligibleTargets: [
        "antigravity",
        "claude-code",
        "codex",
        "cursor",
        "grok-build",
        "hermes",
        "kimi-code",
        "openclaw",
        "opencode-v2",
      ],
      configurationOnlyTargets: [],
      creationTargets: [
        "antigravity",
        "claude-code",
        "codex",
        "cursor",
        "grok-build",
        "hermes",
        "kimi-code",
        "openclaw",
        "opencode-v2",
      ],
    });
    expect(existsSync(marker)).toBe(false);
    expect(result.stderr).not.toContain("FORBIDDEN");
  });

  it("reports every config-only target as eligible without authorizing creation or writes", () => {
    const result = runScenario(emptyExecutableDirectory, homeWithConfigs);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      installedSurfaces: [],
      eligibleTargets: [
        "antigravity",
        "claude-code",
        "codex",
        "cursor",
        "grok-build",
        "hermes",
        "kimi-code",
        "openclaw",
        "opencode-v2",
      ],
      configurationOnlyTargets: [
        "antigravity",
        "claude-code",
        "codex",
        "cursor",
        "grok-build",
        "hermes",
        "kimi-code",
        "openclaw",
        "opencode-v2",
      ],
      creationTargets: [],
    });
    expect(existsSync(marker)).toBe(false);
    expect(result.stderr).not.toContain("FORBIDDEN");
  });
});
