import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const commandPath = "packages/installer/dist/cli.js";
const commandFile = join(repositoryRoot, commandPath);
const distDirectory = join(repositoryRoot, "packages/installer/dist");
const coreDistDirectory = join(repositoryRoot, "packages/client-config/dist");
const sentinelLoader = fileURLToPath(
  new URL("./fixtures/forbid-eager-installer-loads.mjs", import.meta.url),
);
const networkSentinel = fileURLToPath(
  new URL("./fixtures/forbid-network-access.mjs", import.meta.url),
);
const manifest = JSON.parse(
  readFileSync(join(repositoryRoot, "packages/installer/package.json"), "utf8"),
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
        INVOKTA_INSTALLER_DIST_ROOT: distDirectory,
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
      "packages/installer",
      "--pretty",
      "false",
    ],
    { cwd: repositoryRoot, stdio: "pipe" },
  );
});

describe("invokta-installer executable", () => {
  it("retains its Node shebang", () => {
    expect(readFileSync(commandFile, "utf8").split("\n")[0]).toBe(
      "#!/usr/bin/env node",
    );
  });

  it("prints help without loading Clack, filesystem, registry, state, harness, or network modules", () => {
    const result = runCommand("--help");

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`Usage:
  invokta-installer
  invokta-installer install --engine <project-directory>
  invokta-installer install --http <server-name> <url> [--bearer-token-env <NAME>] [--header-env <HEADER=NAME>]...
  invokta-installer status
  invokta-installer enable
  invokta-installer disable
  invokta-installer remove
  invokta-installer remove --engine <project-directory>
  invokta-installer --help
  invokta-installer --version
`);
    expect(result.stderr).toBe("");
  });

  it("prints the manifest version without eager installer or network loads", () => {
    const result = runCommand("--version");

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${manifest.version}\n`);
    expect(result.stderr).toBe("");
  });

  it("rejects invalid usage without eager installer or network loads", () => {
    const result = runCommand("--unknown");

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      'Invalid arguments. Run "invokta-installer --help".\n',
    );
  });

  it("rejects a non-interactive process before eager installer or network loads", () => {
    const result = runCommand();

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "NO_TTY: The installer requires an interactive terminal.\n",
    );
  });

  it("rejects every installer dist module outside the exact eager graph", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-loader",
        sentinelLoader,
        "packages/installer/dist/interactive-session.js",
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          INVOKTA_INSTALLER_DIST_ROOT: distDirectory,
          INVOKTA_CLIENT_CONFIG_DIST_ROOT: coreDistDirectory,
          NODE_NO_WARNINGS: "1",
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unexpected eager installer module");
  });
});
