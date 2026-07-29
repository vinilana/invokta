import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const fixtureDirectory = fileURLToPath(new URL("./fixtures", import.meta.url));
const temporaryRoot = mkdtempSync(join(tmpdir(), "ai-engine-runtime-"));
const executablePath = join(temporaryRoot, "support-engine-mcp");
const markerPath = join(temporaryRoot, "invoked.marker");
const secret = "runtime-secret-child-b26d4f7c";

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
  writeFileSync(
    executablePath,
    `#!/bin/sh\nprintf invoked > ${JSON.stringify(markerPath)}\nexit 97\n`,
  );
  chmodSync(executablePath, 0o755);
});

afterAll(() => {
  rmSync(temporaryRoot, { force: true, recursive: true });
});

describe("runtime requirement process and network sentinels", () => {
  it("resolves stdio and inspects HTTP requirements with all execution and network APIs forbidden", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        join(fixtureDirectory, "forbid-process-execution.mjs"),
        "--import",
        join(fixtureDirectory, "forbid-network-access.mjs"),
        join(fixtureDirectory, "runtime-requirements-sentinel-scenario.mjs"),
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          AI_ENGINE_INSTALLER_RUNTIME_EXECUTABLE: executablePath,
          AI_ENGINE_INSTALLER_RUNTIME_SECRET: secret,
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      stdio: {
        kind: "ready",
        command: {
          declared: executablePath,
          resolved: executablePath,
        },
        requiredEnvironmentNames: ["SUPPORT_API_TOKEN"],
      },
      http: {
        kind: "ready",
        requiredEnvironmentNames: ["SUPPORT_API_TOKEN"],
      },
      resolverCalls: 1,
    });
    expect(result.stdout).not.toContain(secret);
    expect(result.stderr).not.toContain(secret);
    expect(result.stderr).not.toContain("FORBIDDEN");
    expect(existsSync(markerPath)).toBe(false);
  });
});
