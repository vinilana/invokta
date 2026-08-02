import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCreateCapabilityCli } from "../src/cli.js";
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
  const directory = mkdtempSync(join(tmpdir(), "invokta-capability-creator-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("the atomic capability starter", () => {
  it("renders the fixed project deterministically in lexicographic order", () => {
    const options = {
      projectName: "welcome-capability",
      invoktaVersion: "1.2.3",
      packageManager: "npm" as const,
    };
    const files = createStarterFiles(options);

    expect(files.map((file) => file.path)).toEqual([
      ".agents/skills/develop-invokta-project/SKILL.md",
      ".agents/skills/develop-invokta-project/agents/openai.yaml",
      ".gitignore",
      "README.md",
      "package.json",
      "src/capability.ts",
      "src/index.ts",
      "test/capability.test.ts",
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

  it("scaffolds a focused atomic-capability development skill", () => {
    const contents = new Map(
      createStarterFiles({
        projectName: "welcome-capability",
        invoktaVersion: "1.2.3",
        packageManager: "pnpm",
      }).map((file) => [file.path, file.contents]),
    );
    const skill =
      contents.get(".agents/skills/develop-invokta-project/SKILL.md") ?? "";
    const metadata =
      contents.get(
        ".agents/skills/develop-invokta-project/agents/openai.yaml",
      ) ?? "";

    expect(skill).toMatch(
      /^---\nname: develop-invokta-project\ndescription: .+\n---\n/u,
    );
    expect(skill).toContain("Publish through `defineExportedCapability`");
    expect(skill).toContain("Run `pnpm run check`");
    expect(skill).not.toContain("TODO");
    expect(metadata).toContain('display_name: "Develop Invokta Capability"');
    expect(metadata).toContain("$develop-invokta-project");
  });

  it("pins the core and publishes one explicit atomic root export", () => {
    const contents = new Map(
      createStarterFiles({
        projectName: "welcome-capability",
        invoktaVersion: "1.2.3-beta.1",
        packageManager: "npm",
      }).map((file) => [file.path, file.contents]),
    );
    const manifest = JSON.parse(contents.get("package.json") ?? "") as Record<
      string,
      unknown
    >;

    expect(manifest).toMatchObject({
      name: "welcome-capability",
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
      'defaultId: "onboarding.create-welcome-message"',
    );
    expect(contents.get("src/index.ts")).toContain(
      'name: "welcome-capability"',
    );
    expect(contents.get("test/capability.test.ts")).toContain(
      "importCapability(createWelcomeMessageExport)",
    );
    expect(contents.get("test/capability.test.ts")).toContain("engine.invoke(");
  });
});

describe("createStarterProject", () => {
  it("creates the complete starter without replacing existing entries", async () => {
    const cwd = createWorkingDirectory();
    const project = await createStarterProject({
      cwd,
      target: "packages/welcome-capability",
      invoktaVersion: "1.2.3",
      packageManager: "npm",
    });

    expect(project.files).toHaveLength(10);
    expect(project.projectName).toBe("welcome-capability");
    expect(existsSync(join(project.directory, "src/index.ts"))).toBe(true);
    expect(
      readFileSync(
        join(
          project.directory,
          ".agents/skills/develop-invokta-project/SKILL.md",
        ),
        "utf8",
      ),
    ).toContain("# Develop This Atomic Capability");

    await expect(
      createStarterProject({
        cwd,
        target: "packages/welcome-capability",
        invoktaVersion: "1.2.3",
        packageManager: "npm",
      }),
    ).rejects.toMatchObject({ code: "TARGET_NOT_EMPTY", exitCode: 1 });
  });

  it("rejects unsafe and invalid targets without changing them", async () => {
    const cwd = createWorkingDirectory();
    const outside = createWorkingDirectory();
    symlinkSync(outside, join(cwd, "linked"), "dir");
    writeFileSync(join(outside, "sentinel"), "mine\n", "utf8");

    await expect(
      createStarterProject({
        cwd,
        target: "linked/welcome-capability",
        invoktaVersion: "1.2.3",
        packageManager: "npm",
      }),
    ).rejects.toMatchObject({ code: "TARGET_UNSAFE", exitCode: 1 });
    await expect(
      createStarterProject({
        cwd,
        target: "../fixture-secret-payload-marker",
        invoktaVersion: "1.2.3",
        packageManager: "npm",
      }),
    ).rejects.toMatchObject({ code: "TARGET_INVALID", exitCode: 2 });
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
    ["absolute", "/tmp/welcome-capability"],
    ["parent", "../welcome-capability"],
    ["empty segment", "packages//welcome-capability"],
    ["invalid name", "Welcome Capability"],
    ["long name", "a".repeat(215)],
    ["many segments", `${"nested/".repeat(32)}welcome-capability`],
    ["long path", `${"a".repeat(1_025)}-capability`],
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
    const target = join(cwd, "welcome-capability");
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
        target: "welcome-capability",
        invoktaVersion: "1.2.3",
        packageManager: "npm",
        fileSystem,
      }),
    ).rejects.toMatchObject({ code: "SCAFFOLD_CONFLICT", exitCode: 1 });
    expect(
      readFileSync(
        join(target, ".agents/skills/develop-invokta-project/SKILL.md"),
        "utf8",
      ),
    ).toBe("mine\n");
    expect(readdirSync(target)).toEqual([".agents"]);
  });

  it("rolls back only paths created by a failed write", async () => {
    const cwd = createWorkingDirectory();
    const target = join(cwd, "welcome-capability");
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
        target: "welcome-capability",
        invoktaVersion: "1.2.3",
        packageManager: "npm",
        fileSystem,
      }),
    ).rejects.toMatchObject({ code: "WRITE_FAILED", exitCode: 1 });
    expect(readdirSync(target)).toEqual([]);
  });
});

describe("runCreateCapabilityCli", () => {
  it("supports offline creation and sanitized invalid usage", async () => {
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
      runCreateCapabilityCli({
        argv: ["welcome-capability", "--no-install"],
        cwd,
        env: {},
        io,
        install,
        loadPackageVersion: async () => "1.2.3",
      }),
    ).resolves.toBe(0);
    expect(install).not.toHaveBeenCalled();
    expect(stdout.join("")).toContain(
      "Created welcome-capability without installing dependencies.",
    );

    stdout.length = 0;
    await expect(
      runCreateCapabilityCli({
        argv: ["--version", "fixture-secret-payload-marker"],
        cwd,
        io,
      }),
    ).resolves.toBe(2);
    expect(stderr.at(-1)).toBe(
      'Invalid arguments. Run "create-invokta-capability --help".\n',
    );
    expect(stderr.join("")).not.toContain("fixture-secret-payload-marker");
  });

  it("prints its public help and version", async () => {
    const stdout: string[] = [];
    const io = {
      writeStdout(text: string) {
        stdout.push(text);
      },
      writeStderr: vi.fn(),
    };

    await expect(
      runCreateCapabilityCli({ argv: ["--help"], io }),
    ).resolves.toBe(0);
    expect(stdout.join("")).toContain(
      "create-invokta-capability <project-directory>",
    );
    stdout.length = 0;
    await expect(
      runCreateCapabilityCli({
        argv: ["--version"],
        io,
        loadPackageVersion: async () => "1.2.3",
      }),
    ).resolves.toBe(0);
    expect(stdout).toEqual(["1.2.3\n"]);
  });

  it.each([
    { argv: [] },
    { argv: ["welcome-capability", "other-capability"] },
    { argv: ["welcome-capability", "--unknown"] },
    { argv: ["welcome-capability", "--no-install", "--no-install"] },
    { argv: ["welcome-capability", "--package-manager"] },
    { argv: ["welcome-capability", "--package-manager", "bun"] },
    {
      argv: [
        "welcome-capability",
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
        runCreateCapabilityCli({
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
        'Invalid arguments. Run "create-invokta-capability --help".\n',
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
      directory: "/work/welcome-capability",
      packageManager: "pnpm",
      runner,
    });
    expect(runner).toHaveBeenCalledWith({
      command: "pnpm",
      args: ["install"],
      cwd: "/work/welcome-capability",
      shell: false,
      stdio: "inherit",
    });

    await expect(
      installProjectDependencies({
        directory: "/work/welcome-capability",
        packageManager: "npm",
        runner: async () => ({ code: 1, signal: null }),
      }),
    ).rejects.toMatchObject({ code: "INSTALL_FAILED", details: ["npm"] });
  });
});
