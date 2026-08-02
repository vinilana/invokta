import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const commandPath = "packages/console/dist/cli.js";
const commandFile = join(repositoryRoot, commandPath);
const distDirectory = join(repositoryRoot, "packages/console/dist");
const coreDistDirectory = join(repositoryRoot, "packages/client-config/dist");
const sentinelLoader = fileURLToPath(
  new URL("./fixtures/forbid-eager-console-loads.mjs", import.meta.url),
);
const networkSentinel = fileURLToPath(
  new URL("./fixtures/forbid-network-access.mjs", import.meta.url),
);
const manifest = JSON.parse(
  readFileSync(join(repositoryRoot, "packages/console/package.json"), "utf8"),
) as { readonly version: string };

function runCommand(...args: readonly string[]) {
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-loader",
      sentinelLoader,
      "--import",
      networkSentinel,
      commandPath,
      ...args,
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        INVOKTA_CONSOLE_DIST_ROOT: distDirectory,
        INVOKTA_CLIENT_CONFIG_DIST_ROOT: coreDistDirectory,
        NODE_NO_WARNINGS: "1",
      },
    },
  );
  if (result.error !== undefined) throw result.error;
  return result;
}

beforeAll(() => {
  execFileSync(
    process.execPath,
    [
      "node_modules/typescript/bin/tsc",
      "-b",
      "packages/console",
      "--pretty",
      "false",
    ],
    { cwd: repositoryRoot, stdio: "pipe" },
  );
});

describe("invokta-console executable", () => {
  it("retains its Node shebang", () => {
    expect(readFileSync(commandFile, "utf8").split("\n")[0]).toBe(
      "#!/usr/bin/env node",
    );
  });

  it("prints help without loading the server, the core barrel, or a socket", () => {
    const result = runCommand("--help");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("invokta-console [--port <number>]");
    expect(result.stderr).toBe("");
  });

  it("prints the manifest version without eager console or network loads", () => {
    const result = runCommand("--version");

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${manifest.version}\n`);
    expect(result.stderr).toBe("");
  });

  it("rejects invalid usage without eager console or network loads", () => {
    const result = runCommand("--unknown");

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      'Invalid arguments. Run "invokta-console --help".\n',
    );
  });

  it("rejects every console dist module outside the exact eager graph", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-loader",
        sentinelLoader,
        "packages/console/dist/console-server.js",
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          INVOKTA_CONSOLE_DIST_ROOT: distDirectory,
          INVOKTA_CLIENT_CONFIG_DIST_ROOT: coreDistDirectory,
          NODE_NO_WARNINGS: "1",
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unexpected eager console module");
  });
});
