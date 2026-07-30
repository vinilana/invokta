import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCreateCapabilityLibraryCli } from "../src/cli.js";
import {
  installProjectDependencies,
  type PackageManagerRunner,
} from "../src/install.js";
import {
  createStarterProject,
  defaultScaffoldFileSystem,
  type ScaffoldFileSystem,
} from "../src/scaffold.js";
import { createStarterFiles } from "../src/starter.js";

const temporaryDirectories: string[] = [];

function createWorkingDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "invokta-library-creator-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("the capability library starter", () => {
  it("renders the fixed project deterministically in lexicographic order", () => {
    const options = {
      projectName: "onboarding-capabilities",
      invoktaVersion: "1.2.3",
      packageManager: "yarn" as const,
    };
    const files = createStarterFiles(options);

    expect(files.map((file) => file.path)).toEqual([
      ".gitignore",
      "README.md",
      "package.json",
      "src/capabilities/create-farewell-message.ts",
      "src/capabilities/create-welcome-message.ts",
      "src/index.ts",
      "test/library.test.ts",
      "tsconfig.json",
      "tsconfig.test.json",
    ]);
    expect(files).toEqual(createStarterFiles(options));
    for (const file of files) {
      expect(file.contents).not.toContain("\r");
      expect(file.contents.endsWith("\n")).toBe(true);
      expect(file.contents.endsWith("\n\n")).toBe(false);
    }
  });

  it("pins the core and publishes one explicit library root export", () => {
    const contents = new Map(
      createStarterFiles({
        projectName: "onboarding-capabilities",
        invoktaVersion: "1.2.3-beta.1",
        packageManager: "npm",
      }).map((file) => [file.path, file.contents]),
    );
    const manifest = JSON.parse(contents.get("package.json") ?? "") as Record<
      string,
      unknown
    >;

    expect(manifest).toMatchObject({
      name: "onboarding-capabilities",
      version: "0.1.0",
      private: true,
      type: "module",
      sideEffects: false,
      exports: {
        ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      },
      dependencies: { "@invokta/core": "1.2.3-beta.1", zod: "4.4.3" },
    });
    expect(contents.get("src/index.ts")).toContain(
      'name: "onboarding-capabilities"',
    );
    expect(contents.get("src/index.ts")).toContain(
      '"onboarding.create-welcome-message": createWelcomeMessage',
    );
    expect(contents.get("src/index.ts")).toContain(
      '"onboarding.create-farewell-message": createFarewellMessage',
    );
    expect(contents.get("test/library.test.ts")).toContain(
      "importCapabilities(onboardingCapabilityLibrary",
    );
    expect(contents.get("test/library.test.ts")).toContain("engine.invoke(");
  });
});

describe("createStarterProject", () => {
  it("creates the complete starter and rejects unsafe paths", async () => {
    const cwd = createWorkingDirectory();
    const project = await createStarterProject({
      cwd,
      target: "onboarding-capabilities",
      invoktaVersion: "1.2.3",
      packageManager: "npm",
    });

    expect(project.files).toHaveLength(9);
    expect(existsSync(join(project.directory, "src/index.ts"))).toBe(true);

    const outside = createWorkingDirectory();
    symlinkSync(outside, join(cwd, "linked"), "dir");
    writeFileSync(join(outside, "sentinel"), "mine\n", "utf8");
    await expect(
      createStarterProject({
        cwd,
        target: "linked/unsafe-library",
        invoktaVersion: "1.2.3",
        packageManager: "npm",
      }),
    ).rejects.toMatchObject({ code: "TARGET_UNSAFE", exitCode: 1 });
    expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("mine\n");
  });

  it("accepts every inclusive target limit", async () => {
    const cwd = createWorkingDirectory();
    const projectName = "a".repeat(214);
    const pathAtLimit = [
      ...Array.from({ length: 31 }, () => "a".repeat(31)),
      "b".repeat(32),
    ].join("/");
    expect([...pathAtLimit]).toHaveLength(1_024);

    await expect(
      createStarterProject({
        cwd,
        target: projectName,
        invoktaVersion: "1.2.3",
        packageManager: "npm",
      }),
    ).resolves.toMatchObject({ projectName });
    await expect(
      createStarterProject({
        cwd,
        target: pathAtLimit,
        invoktaVersion: "1.2.3",
        packageManager: "npm",
      }),
    ).resolves.toMatchObject({ projectName: "b".repeat(32) });
  });

  it.each([
    ["absolute", "/tmp/onboarding-capabilities"],
    ["parent", "../onboarding-capabilities"],
    ["empty segment", "packages//onboarding-capabilities"],
    ["invalid name", "Onboarding Capabilities"],
    ["long name", "a".repeat(215)],
    ["many segments", `${"nested/".repeat(32)}onboarding-capabilities`],
    ["long path", `${"a".repeat(1_025)}-library`],
  ])(
    "rejects an exclusive %s target before writing",
    async (_label, target) => {
      const cwd = createWorkingDirectory();

      await expect(
        createStarterProject({
          cwd,
          target,
          invoktaVersion: "1.2.3",
          packageManager: "npm",
        }),
      ).rejects.toMatchObject({ code: "TARGET_INVALID", exitCode: 2 });
      expect(readdirSync(cwd)).toEqual([]);
    },
  );

  it("preserves an entry that wins an exclusive-write race", async () => {
    const cwd = createWorkingDirectory();
    const target = join(cwd, "onboarding-capabilities");
    let raced = false;
    const fileSystem: ScaffoldFileSystem = {
      ...defaultScaffoldFileSystem,
      async writeFile(path, contents, options) {
        if (!raced) {
          raced = true;
          writeFileSync(path, "mine\n", "utf8");
        }
        await defaultScaffoldFileSystem.writeFile(path, contents, options);
      },
    };

    await expect(
      createStarterProject({
        cwd,
        target: "onboarding-capabilities",
        invoktaVersion: "1.2.3",
        packageManager: "npm",
        fileSystem,
      }),
    ).rejects.toMatchObject({ code: "SCAFFOLD_CONFLICT", exitCode: 1 });
    expect(readFileSync(join(target, ".gitignore"), "utf8")).toBe("mine\n");
    expect(readdirSync(target)).toEqual([".gitignore"]);
  });

  it("rolls back only paths created by a failed write", async () => {
    const cwd = createWorkingDirectory();
    const target = join(cwd, "onboarding-capabilities");
    mkdirSync(target);
    let writes = 0;
    const fileSystem: ScaffoldFileSystem = {
      ...defaultScaffoldFileSystem,
      async writeFile(path, contents, options) {
        writes += 1;
        if (writes === 3) {
          const error = new Error("fixture failure") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
        await defaultScaffoldFileSystem.writeFile(path, contents, options);
      },
    };

    await expect(
      createStarterProject({
        cwd,
        target: "onboarding-capabilities",
        invoktaVersion: "1.2.3",
        packageManager: "npm",
        fileSystem,
      }),
    ).rejects.toMatchObject({ code: "WRITE_FAILED", exitCode: 1 });
    expect(readdirSync(target)).toEqual([]);
  });
});

describe("runCreateCapabilityLibraryCli", () => {
  it("supports offline creation, public help, and sanitized invalid usage", async () => {
    const cwd = createWorkingDirectory();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const install = vi.fn();
    const io = {
      writeStdout(text: string) {
        stdout.push(text);
      },
      writeStderr(text: string) {
        stderr.push(text);
      },
    };

    await expect(
      runCreateCapabilityLibraryCli({
        argv: ["onboarding-capabilities", "--no-install"],
        cwd,
        env: {},
        io,
        install,
        loadPackageVersion: async () => "1.2.3",
      }),
    ).resolves.toBe(0);
    expect(install).not.toHaveBeenCalled();
    expect(stdout.join("")).toContain(
      "Created onboarding-capabilities without installing dependencies.",
    );

    stdout.length = 0;
    await expect(
      runCreateCapabilityLibraryCli({ argv: ["--help"], io }),
    ).resolves.toBe(0);
    expect(stdout.join("")).toContain(
      "create-invokta-capability-library <project-directory>",
    );

    await expect(
      runCreateCapabilityLibraryCli({
        argv: ["../fixture-secret-payload-marker", "--no-install"],
        cwd,
        io,
        loadPackageVersion: async () => "1.2.3",
      }),
    ).resolves.toBe(2);
    expect(stderr.at(-1)).toBe(
      "TARGET_INVALID: The project path or name is invalid.\n",
    );
    expect(stderr.join("")).not.toContain("fixture-secret-payload-marker");
  });

  it.each([
    { argv: [] },
    { argv: ["onboarding-capabilities", "other-library"] },
    { argv: ["onboarding-capabilities", "--unknown"] },
    {
      argv: ["onboarding-capabilities", "--no-install", "--no-install"],
    },
    { argv: ["onboarding-capabilities", "--package-manager"] },
    { argv: ["onboarding-capabilities", "--package-manager", "bun"] },
    {
      argv: [
        "onboarding-capabilities",
        "--package-manager",
        "npm",
        "--package-manager",
        "pnpm",
      ],
    },
  ])(
    "rejects invalid arguments without creating a project: $argv",
    async ({ argv }) => {
      const cwd = createWorkingDirectory();
      const stderr: string[] = [];

      await expect(
        runCreateCapabilityLibraryCli({
          argv,
          cwd,
          io: {
            writeStdout: vi.fn(),
            writeStderr(text) {
              stderr.push(text);
            },
          },
        }),
      ).resolves.toBe(2);
      expect(stderr).toEqual([
        'Invalid arguments. Run "create-invokta-capability-library --help".\n',
      ]);
      expect(readdirSync(cwd)).toEqual([]);
    },
  );
});

describe("installProjectDependencies", () => {
  it("runs one shell-free foreground install and normalizes failure", async () => {
    const runner = vi.fn<PackageManagerRunner>(async () => ({
      code: 0,
      signal: null,
    }));
    await installProjectDependencies({
      directory: "/work/onboarding-capabilities",
      packageManager: "yarn",
      runner,
    });
    expect(runner).toHaveBeenCalledWith({
      command: "yarn",
      args: ["install"],
      cwd: "/work/onboarding-capabilities",
      shell: false,
      stdio: "inherit",
    });

    await expect(
      installProjectDependencies({
        directory: "/work/onboarding-capabilities",
        packageManager: "pnpm",
        runner: async () => {
          throw new Error("fixture child failure");
        },
      }),
    ).rejects.toMatchObject({ code: "INSTALL_FAILED", details: ["pnpm"] });
  });
});
