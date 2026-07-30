import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

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
});

describe("engine removal isolation sentinels", () => {
  it("removes an owned engine without process, network, runtime, or launch-environment access", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        joinFixture("forbid-process-execution.mjs"),
        "--import",
        joinFixture("forbid-network-access.mjs"),
        joinFixture("engine-removal-sentinel-scenario.mjs"),
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      result: 0,
      environmentReads: ["XDG_STATE_HOME"],
      installations: 0,
    });
    expect(result.stdout).not.toContain("SUPPORT_API_TOKEN");
    expect(result.stderr).not.toContain("FORBIDDEN");
    expect(result.stderr).not.toContain("LAUNCH_ENVIRONMENT_VALUE_READ");
  });
});

function joinFixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}
