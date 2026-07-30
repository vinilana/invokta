import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CreatorError } from "../src/errors.js";
import {
  createStarterProject,
  defaultScaffoldFileSystem,
  type ScaffoldFileSystem,
} from "../src/scaffold.js";

const temporaryDirectories: string[] = [];

function createWorkingDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "invokta-creator-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function createProject(cwd: string, target = "my-engine") {
  return createStarterProject({
    cwd,
    target,
    invoktaVersion: "1.2.3",
    packageManager: "npm",
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("createStarterProject", () => {
  it("creates a complete project in an absent nested target", async () => {
    const cwd = createWorkingDirectory();

    const result = await createProject(cwd, "engines/my-engine");

    expect(result.projectName).toBe("my-engine");
    expect(result.directory).toBe(join(cwd, "engines/my-engine"));
    expect(result.files).toHaveLength(14);
    expect(
      JSON.parse(readFileSync(join(result.directory, "package.json"), "utf8")),
    ).toMatchObject({ name: "my-engine", private: true });
    expect(lstatSync(join(result.directory, "AGENTS.md")).isFile()).toBe(true);
    expect(
      lstatSync(join(result.directory, "CLAUDE.md")).isSymbolicLink(),
    ).toBe(true);
    expect(readlinkSync(join(result.directory, "CLAUDE.md"))).toBe("AGENTS.md");
  });

  it("creates the starter in an existing empty directory", async () => {
    const cwd = createWorkingDirectory();
    mkdirSync(join(cwd, "my-engine"));

    await createProject(cwd);

    expect(readdirSync(join(cwd, "my-engine")).sort()).toEqual([
      ".gitignore",
      "AGENTS.md",
      "CLAUDE.md",
      "README.md",
      "invokta.mcp.json",
      "package.json",
      "src",
      "test",
      "tsconfig.json",
      "tsconfig.test.json",
    ]);
  });

  it("accepts dot only for a valid empty working-directory name", async () => {
    const parent = createWorkingDirectory();
    const cwd = join(parent, "current-engine");
    mkdirSync(cwd);

    const result = await createProject(cwd, ".");

    expect(result.directory).toBe(cwd);
    expect(result.projectName).toBe("current-engine");
  });

  it("accepts the inclusive project-name limit", async () => {
    const cwd = createWorkingDirectory();
    const projectName = "a".repeat(214);

    const result = await createProject(cwd, projectName);

    expect(result.projectName).toBe(projectName);
    expect(existsSync(join(result.directory, "package.json"))).toBe(true);
  });

  it("accepts the inclusive path-scalar and segment limits", async () => {
    const cwd = createWorkingDirectory();
    const target = [
      ...Array.from({ length: 31 }, () => "a".repeat(31)),
      "b".repeat(32),
    ].join("/");
    expect([...target]).toHaveLength(1_024);

    const result = await createProject(cwd, target);

    expect(result.projectName).toBe("b".repeat(32));
    expect(existsSync(join(result.directory, "package.json"))).toBe(true);
  });

  it("rejects a non-empty target without changing it", async () => {
    const cwd = createWorkingDirectory();
    const target = join(cwd, "my-engine");
    mkdirSync(target);
    writeFileSync(join(target, ".keep"), "mine\n", "utf8");

    await expect(createProject(cwd)).rejects.toMatchObject({
      code: "TARGET_NOT_EMPTY",
      exitCode: 1,
    });
    expect(readFileSync(join(target, ".keep"), "utf8")).toBe("mine\n");
    expect(readdirSync(target)).toEqual([".keep"]);
  });

  it.each([
    ["an absolute path", "/tmp/my-engine"],
    ["a parent segment", "../my-engine"],
    ["a nested parent segment", "engines/../my-engine"],
    ["an invalid package name", "My Engine"],
    ["an empty name segment", "engines//my-engine"],
    ["a project name over 214 characters", "a".repeat(215)],
    ["too many segments", `${"nested/".repeat(32)}my-engine`],
    ["too many scalars", `${"a".repeat(1_025)}-engine`],
  ])("rejects %s before creating a target", async (_label, target) => {
    const cwd = createWorkingDirectory();

    await expect(createProject(cwd, target)).rejects.toMatchObject({
      code: "TARGET_INVALID",
      exitCode: 2,
    });
    expect(readdirSync(cwd)).toEqual([]);
  });

  it("rejects a symbolic-link target without following it", async () => {
    const cwd = createWorkingDirectory();
    const outside = createWorkingDirectory();
    symlinkSync(outside, join(cwd, "my-engine"), "dir");

    await expect(createProject(cwd)).rejects.toMatchObject({
      code: "TARGET_UNSAFE",
      exitCode: 1,
    });
    expect(readdirSync(outside)).toEqual([]);
  });

  it("rejects a non-directory target without replacing it", async () => {
    const cwd = createWorkingDirectory();
    writeFileSync(join(cwd, "my-engine"), "mine\n", "utf8");

    await expect(createProject(cwd)).rejects.toMatchObject({
      code: "TARGET_UNSAFE",
      exitCode: 1,
    });
    expect(readFileSync(join(cwd, "my-engine"), "utf8")).toBe("mine\n");
  });

  it("rejects a symbolic-link parent without following it", async () => {
    const cwd = createWorkingDirectory();
    const outside = createWorkingDirectory();
    symlinkSync(outside, join(cwd, "engines"), "dir");

    await expect(createProject(cwd, "engines/my-engine")).rejects.toMatchObject(
      {
        code: "TARGET_UNSAFE",
        exitCode: 1,
      },
    );
    expect(readdirSync(outside)).toEqual([]);
  });

  it("preserves a file that wins an exclusive-write race", async () => {
    const cwd = createWorkingDirectory();
    const target = join(cwd, "my-engine");
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
        target: "my-engine",
        invoktaVersion: "1.2.3",
        packageManager: "npm",
        fileSystem,
      }),
    ).rejects.toMatchObject({ code: "SCAFFOLD_CONFLICT", exitCode: 1 });
    expect(readFileSync(join(target, ".gitignore"), "utf8")).toBe("mine\n");
    expect(readdirSync(target)).toEqual([".gitignore"]);
  });

  it("preserves a symbolic link that wins an exclusive-create race", async () => {
    const cwd = createWorkingDirectory();
    const target = join(cwd, "my-engine");
    const fileSystem: ScaffoldFileSystem = {
      ...defaultScaffoldFileSystem,
      async symlink(linkTarget, path) {
        symlinkSync("external-agents.md", path);
        await defaultScaffoldFileSystem.symlink(linkTarget, path);
      },
    };

    await expect(
      createStarterProject({
        cwd,
        target: "my-engine",
        invoktaVersion: "1.2.3",
        packageManager: "npm",
        fileSystem,
      }),
    ).rejects.toMatchObject({
      code: "SCAFFOLD_CONFLICT",
      exitCode: 1,
      details: ["CLAUDE.md"],
    });
    expect(readdirSync(target)).toEqual(["CLAUDE.md"]);
    expect(readlinkSync(join(target, "CLAUDE.md"))).toBe("external-agents.md");
  });

  it("normalizes a symbolic-link creation failure and rolls back", async () => {
    const cwd = createWorkingDirectory();
    const target = join(cwd, "my-engine");
    mkdirSync(target);
    const fileSystem: ScaffoldFileSystem = {
      ...defaultScaffoldFileSystem,
      async symlink() {
        const error = new Error(
          "fixture link failure",
        ) as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      },
    };

    await expect(
      createStarterProject({
        cwd,
        target: "my-engine",
        invoktaVersion: "1.2.3",
        packageManager: "npm",
        fileSystem,
      }),
    ).rejects.toMatchObject({
      code: "WRITE_FAILED",
      exitCode: 1,
      details: ["CLAUDE.md"],
    });
    expect(readdirSync(target)).toEqual([]);
  });

  it("rolls back only paths created by a failed scaffold write", async () => {
    const cwd = createWorkingDirectory();
    const target = join(cwd, "my-engine");
    mkdirSync(target);
    let writes = 0;
    let linkCreated = false;
    const fileSystem: ScaffoldFileSystem = {
      ...defaultScaffoldFileSystem,
      async symlink(linkTarget, path) {
        await defaultScaffoldFileSystem.symlink(linkTarget, path);
        linkCreated = true;
      },
      async writeFile(path, contents, options) {
        writes += 1;
        if (writes === 3) {
          const error = new Error(
            "fixture write failure",
          ) as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
        await defaultScaffoldFileSystem.writeFile(path, contents, options);
      },
    };

    await expect(
      createStarterProject({
        cwd,
        target: "my-engine",
        invoktaVersion: "1.2.3",
        packageManager: "npm",
        fileSystem,
      }),
    ).rejects.toBeInstanceOf(CreatorError);
    expect(linkCreated).toBe(true);
    expect(existsSync(target)).toBe(true);
    expect(readdirSync(target)).toEqual([]);
  });

  it("removes an absent target root after a failed scaffold write", async () => {
    const cwd = createWorkingDirectory();
    const fileSystem: ScaffoldFileSystem = {
      ...defaultScaffoldFileSystem,
      async writeFile() {
        const error = new Error(
          "fixture write failure",
        ) as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      },
    };

    await expect(
      createStarterProject({
        cwd,
        target: "nested/my-engine",
        invoktaVersion: "1.2.3",
        packageManager: "npm",
        fileSystem,
      }),
    ).rejects.toMatchObject({ code: "WRITE_FAILED", exitCode: 1 });
    expect(existsSync(join(cwd, "nested"))).toBe(false);
  });
});
