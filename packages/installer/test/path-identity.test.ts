import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { InstallerTransactionFileSystem } from "../src/file-system.js";
import { createNodeFileSystem } from "../src/node-file-system.js";
import {
  bootstrapPrivateDirectory,
  capturePathIdentity,
  capturePathRoot,
  InstallerPathIdentityError,
  revalidatePathIdentity,
} from "../src/path-identity.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryHome(): string {
  const directory = mkdtempSync(join(tmpdir(), "invokta-path-identity-"));
  temporaryDirectories.push(directory);
  return directory;
}

function currentUserId(): number {
  if (process.getuid === undefined) {
    throw new Error("POSIX user identity is required by this fixture.");
  }
  return process.getuid();
}

async function expectIdentityError(
  promise: Promise<unknown>,
  code: InstallerPathIdentityError["code"],
): Promise<void> {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(InstallerPathIdentityError);
  expect(error).toMatchObject({ code });
}

describe.skipIf(process.platform === "win32")("installer path identity", () => {
  it("captures an authorized root and distinguishes an absent file from an existing empty file", async () => {
    const home = temporaryHome();
    const fileSystem = createNodeFileSystem();
    const root = await capturePathRoot(fileSystem, {
      rootKind: "home",
      rootPath: home,
      currentUserId: currentUserId(),
    });
    const targetPath = join(home, ".codex/config.toml");

    const absent = await capturePathIdentity(fileSystem, {
      root,
      targetPath,
      targetKind: "regular-file",
    });
    expect(absent.components).toHaveLength(1);
    expect(absent.missingPaths).toEqual([join(home, ".codex"), targetPath]);

    mkdirSync(dirname(targetPath), { mode: 0o700 });
    writeFileSync(targetPath, "", { mode: 0o600 });
    const present = await capturePathIdentity(fileSystem, {
      root,
      targetPath,
      targetKind: "regular-file",
    });
    expect(present.missingPaths).toEqual([]);
    expect(present.components.at(-1)).toMatchObject({
      path: targetPath,
      kind: "regular-file",
      uid: currentUserId(),
    });
    expect(typeof present.components.at(-1)?.dev).toBe("bigint");
    expect(typeof present.components.at(-1)?.ino).toBe("bigint");
  });

  it("rejects paths outside the captured root, symlinks, wrong owners, and wrong terminal kinds", async () => {
    const home = temporaryHome();
    const outside = temporaryHome();
    const fileSystem = createNodeFileSystem();
    const root = await capturePathRoot(fileSystem, {
      rootKind: "home",
      rootPath: home,
      currentUserId: currentUserId(),
    });

    await expectIdentityError(
      capturePathIdentity(fileSystem, {
        root,
        targetPath: join(outside, "config.json"),
        targetKind: "regular-file",
      }),
      "OUTSIDE_ROOT",
    );

    symlinkSync(outside, join(home, ".codex"), "dir");
    await expectIdentityError(
      capturePathIdentity(fileSystem, {
        root,
        targetPath: join(home, ".codex/config.toml"),
        targetKind: "regular-file",
      }),
      "COMPONENT_UNSAFE",
    );

    await expectIdentityError(
      capturePathRoot(fileSystem, {
        rootKind: "home",
        rootPath: home,
        currentUserId: currentUserId() + 1,
      }),
      "ROOT_UNSAFE",
    );

    mkdirSync(join(home, "directory-target"));
    await expectIdentityError(
      capturePathIdentity(fileSystem, {
        root,
        targetPath: join(home, "directory-target"),
        targetKind: "regular-file",
      }),
      "COMPONENT_UNSAFE",
    );
  });

  it("revalidates every component and detects a completed inode substitution", async () => {
    const home = temporaryHome();
    const configDirectory = join(home, ".codex");
    const targetPath = join(configDirectory, "config.toml");
    mkdirSync(configDirectory);
    writeFileSync(targetPath, "first\n");
    const fileSystem = createNodeFileSystem();
    const root = await capturePathRoot(fileSystem, {
      rootKind: "home",
      rootPath: home,
      currentUserId: currentUserId(),
    });
    const expected = await capturePathIdentity(fileSystem, {
      root,
      targetPath,
      targetKind: "regular-file",
    });

    await expect(revalidatePathIdentity(fileSystem, expected)).resolves.toEqual(
      expected,
    );

    renameSync(configDirectory, join(home, ".codex-original"));
    mkdirSync(configDirectory);
    writeFileSync(targetPath, "second\n");
    await expectIdentityError(
      revalidatePathIdentity(fileSystem, expected),
      "IDENTITY_CHANGED",
    );
  });

  it("bootstraps only the captured missing suffix with mode 0700", async () => {
    const home = temporaryHome();
    const fileSystem = createNodeFileSystem();
    const root = await capturePathRoot(fileSystem, {
      rootKind: "home",
      rootPath: home,
      currentUserId: currentUserId(),
    });
    const directoryPath = join(home, ".local/state/invokta");
    const expected = await capturePathIdentity(fileSystem, {
      root,
      targetPath: directoryPath,
      targetKind: "directory",
    });

    const created = await bootstrapPrivateDirectory(fileSystem, { expected });

    expect(created.missingPaths).toEqual([]);
    expect(created.components.map(({ path }) => path)).toEqual([
      home,
      join(home, ".local"),
      join(home, ".local/state"),
      directoryPath,
    ]);
    for (const path of created.components.slice(1).map(({ path }) => path)) {
      expect(statSync(path).mode & 0o777).toBe(0o700);
    }
  });

  it("accepts a safe EEXIST race only after capturing the raced directory", async () => {
    const home = temporaryHome();
    const nodeFileSystem = createNodeFileSystem();
    let raced = false;
    const fileSystem: InstallerTransactionFileSystem = {
      ...nodeFileSystem,
      mkdir: async (path, mode) => {
        if (!raced) {
          raced = true;
          await nodeFileSystem.mkdir(path, mode);
        }
        return nodeFileSystem.mkdir(path, mode);
      },
    };
    const root = await capturePathRoot(fileSystem, {
      rootKind: "state",
      rootPath: home,
      currentUserId: currentUserId(),
    });
    const targetPath = join(home, "invokta/nested");
    const expected = await capturePathIdentity(fileSystem, {
      root,
      targetPath,
      targetKind: "directory",
    });

    const created = await bootstrapPrivateDirectory(fileSystem, { expected });

    expect(raced).toBe(true);
    expect(created.missingPaths).toEqual([]);
    expect(created.components.at(1)?.path).toBe(join(home, "invokta"));
    expect(statSync(join(home, "invokta")).mode & 0o777).toBe(0o700);
  });

  it("rejects an EEXIST race that installs a symlink", async () => {
    const home = temporaryHome();
    const outside = temporaryHome();
    const nodeFileSystem = createNodeFileSystem();
    let raced = false;
    const fileSystem: InstallerTransactionFileSystem = {
      ...nodeFileSystem,
      mkdir: async (path, mode) => {
        if (!raced) {
          raced = true;
          symlinkSync(outside, path, "dir");
        }
        return nodeFileSystem.mkdir(path, mode);
      },
    };
    const root = await capturePathRoot(fileSystem, {
      rootKind: "home",
      rootPath: home,
      currentUserId: currentUserId(),
    });
    const expected = await capturePathIdentity(fileSystem, {
      root,
      targetPath: join(home, ".config/opencode"),
      targetKind: "directory",
    });

    await expectIdentityError(
      bootstrapPrivateDirectory(fileSystem, { expected }),
      "COMPONENT_UNSAFE",
    );
    expect(raced).toBe(true);
  });
});
