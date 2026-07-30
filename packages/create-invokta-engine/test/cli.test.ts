import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type CreateEngineIo,
  type InstallProject,
  runCreateEngineCli,
} from "../src/cli.js";

const temporaryDirectories: string[] = [];

function createWorkingDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "invokta-creator-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}

function createHarness(
  overrides: Partial<CreateEngineIo> = {},
): CreateEngineIo & { readonly stdout: string[]; readonly stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    writeStdout:
      overrides.writeStdout ??
      ((text) => {
        stdout.push(text);
      }),
    writeStderr:
      overrides.writeStderr ??
      ((text) => {
        stderr.push(text);
      }),
  };
}

const invalidArgumentCases: readonly Readonly<{
  argv: readonly string[];
}>[] = [
  { argv: [] },
  { argv: ["my-engine", "other-engine"] },
  { argv: ["my-engine", "--unknown"] },
  { argv: ["my-engine", "--no-install", "--no-install"] },
  { argv: ["my-engine", "--package-manager"] },
  { argv: ["my-engine", "--package-manager", "bun"] },
  {
    argv: [
      "my-engine",
      "--package-manager",
      "npm",
      "--package-manager",
      "pnpm",
    ],
  },
  { argv: ["--help", "my-engine"] },
  { argv: ["--version", "fixture-secret-payload-marker"] },
];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("runCreateEngineCli", () => {
  it("creates without installing when --no-install is present", async () => {
    const cwd = createWorkingDirectory();
    const io = createHarness();
    const install = vi.fn<InstallProject>();

    const exitCode = await runCreateEngineCli({
      argv: ["my-engine", "--no-install"],
      cwd,
      env: {},
      io,
      install,
      loadPackageVersion: async () => "1.2.3",
    });

    expect(exitCode).toBe(0);
    expect(install).not.toHaveBeenCalled();
    expect(io.stderr).toEqual([]);
    expect(io.stdout.join("")).toBe(
      "Created my-engine without installing dependencies.\n\n" +
        "Next steps:\n" +
        "  npm install --no-audit --no-fund\n" +
        "  npm run check\n",
    );
    expect(
      JSON.parse(readFileSync(join(cwd, "my-engine/package.json"), "utf8")),
    ).toMatchObject({
      name: "my-engine",
      dependencies: { "@invokta/core": "1.2.3" },
    });
  });

  it("installs once after the complete scaffold using the inferred manager", async () => {
    const cwd = createWorkingDirectory();
    const io = createHarness();
    const install = vi.fn<InstallProject>(
      async ({ directory, packageManager }) => {
        expect(packageManager).toBe("pnpm");
        expect(existsSync(join(directory, "src/engine.ts"))).toBe(true);
      },
    );

    const exitCode = await runCreateEngineCli({
      argv: ["my-engine"],
      cwd,
      env: { npm_config_user_agent: "pnpm/10.14.0 npm/? node/v22.20.0" },
      io,
      install,
      loadPackageVersion: async () => "1.2.3",
    });

    expect(exitCode).toBe(0);
    expect(install).toHaveBeenCalledOnce();
    expect(io.stderr).toEqual([]);
    expect(io.stdout.join("")).toBe(
      "Created my-engine.\n\nNext step:\n  pnpm run check\n",
    );
  });

  it("uses an explicit package manager instead of the inferred manager", async () => {
    const cwd = createWorkingDirectory();
    const io = createHarness();
    const install = vi.fn<InstallProject>(async () => undefined);

    await runCreateEngineCli({
      argv: ["--package-manager", "yarn", "my-engine"],
      cwd,
      env: { npm_config_user_agent: "pnpm/10.14.0" },
      io,
      install,
      loadPackageVersion: async () => "1.2.3",
    });

    expect(install).toHaveBeenCalledWith({
      directory: join(cwd, "my-engine"),
      packageManager: "yarn",
    });
    expect(readFileSync(join(cwd, "my-engine/README.md"), "utf8")).toContain(
      "yarn run check",
    );
    expect(io.stdout.join("")).toContain("yarn run check");
  });

  it("preserves the complete scaffold when installation fails", async () => {
    const cwd = createWorkingDirectory();
    const io = createHarness();

    const exitCode = await runCreateEngineCli({
      argv: ["my-engine"],
      cwd,
      env: {},
      io,
      install: async () => {
        const { CreatorError } = await import("../src/errors.js");
        throw new CreatorError("INSTALL_FAILED", ["npm"]);
      },
      loadPackageVersion: async () => "1.2.3",
    });

    expect(exitCode).toBe(1);
    expect(io.stdout).toEqual([]);
    expect(io.stderr.join("")).toBe(
      "INSTALL_FAILED: The project dependencies could not be installed.\n" +
        "  npm\n",
    );
    expect(existsSync(join(cwd, "my-engine/package.json"))).toBe(true);
    expect(readdirSync(join(cwd, "my-engine"))).toHaveLength(8);
  });

  it.each(invalidArgumentCases)(
    "rejects invalid arguments without creating a project: $argv",
    async ({ argv }) => {
      const cwd = createWorkingDirectory();
      const io = createHarness();
      const install = vi.fn<InstallProject>();

      const exitCode = await runCreateEngineCli({
        argv,
        cwd,
        env: {},
        io,
        install,
      });

      expect(exitCode).toBe(2);
      expect(io.stdout).toEqual([]);
      expect(io.stderr).toEqual([
        'Invalid arguments. Run "create-invokta-engine --help".\n',
      ]);
      expect(io.stderr.join("")).not.toContain("fixture-secret-payload-marker");
      expect(install).not.toHaveBeenCalled();
      expect(readdirSync(cwd)).toEqual([]);
    },
  );

  it("prints help without loading the package version", async () => {
    const io = createHarness();
    const loadPackageVersion = vi.fn<() => Promise<string>>();

    const exitCode = await runCreateEngineCli({
      argv: ["--help"],
      io,
      loadPackageVersion,
    });

    expect(exitCode).toBe(0);
    expect(loadPackageVersion).not.toHaveBeenCalled();
    expect(io.stderr).toEqual([]);
    expect(io.stdout.join("")).toContain(
      "create-invokta-engine <project-directory>",
    );
  });

  it("prints the loaded package version", async () => {
    const io = createHarness();

    const exitCode = await runCreateEngineCli({
      argv: ["--version"],
      io,
      loadPackageVersion: async () => "1.2.3",
    });

    expect(exitCode).toBe(0);
    expect(io.stderr).toEqual([]);
    expect(io.stdout).toEqual(["1.2.3\n"]);
  });

  it("renders a target error without echoing the rejected path", async () => {
    const cwd = createWorkingDirectory();
    const io = createHarness();

    const exitCode = await runCreateEngineCli({
      argv: ["../fixture-secret-payload-marker", "--no-install"],
      cwd,
      io,
      loadPackageVersion: async () => "1.2.3",
    });

    expect(exitCode).toBe(2);
    expect(io.stdout).toEqual([]);
    expect(io.stderr.join("")).toBe(
      "TARGET_INVALID: The project path or name is invalid.\n",
    );
    expect(io.stderr.join("")).not.toContain("fixture-secret-payload-marker");
  });

  it("contains a rejected diagnostic writer", async () => {
    const cwd = createWorkingDirectory();
    writeFileSync(join(cwd, "sentinel"), "mine\n", "utf8");
    const io = createHarness({
      writeStderr: async () => {
        throw new Error("closed diagnostic stream");
      },
    });

    await expect(
      runCreateEngineCli({
        argv: ["my-engine", "--unknown"],
        cwd,
        io,
      }),
    ).resolves.toBe(2);
  });
});
