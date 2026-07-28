import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  InstallerFileSystemError,
  maximumInstallerFileBytes,
} from "../src/file-system.js";
import { createNodeFileSystem } from "../src/node-file-system.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "ai-engine-transaction-fs-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function expectFileSystemError(
  promise: Promise<unknown>,
  code: InstallerFileSystemError["code"],
): Promise<void> {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(InstallerFileSystemError);
  expect(error).toMatchObject({ code });
}

describe.skipIf(process.platform === "win32")(
  "Node installer transaction filesystem adapter",
  () => {
    it("reports no-follow path and descriptor identity with bigint device and inode", async () => {
      const directory = temporaryDirectory();
      const path = join(directory, "config.json");
      writeFileSync(path, "{}\n", { mode: 0o640 });
      const fileSystem = createNodeFileSystem();

      const pathStat = await fileSystem.inspectPathNoFollow(path);
      expect(pathStat).toMatchObject({
        kind: "regular-file",
        uid: process.getuid?.(),
        gid: process.getgid?.(),
      });
      if (pathStat.kind === "missing") {
        throw new Error("The fixture file must exist.");
      }
      expect(typeof pathStat.dev).toBe("bigint");
      expect(typeof pathStat.ino).toBe("bigint");
      expect(pathStat.mode & 0o777).toBe(0o640);

      const handle = await fileSystem.openReadNoFollow(path);
      try {
        await expect(handle.stat()).resolves.toEqual(pathStat);
      } finally {
        await handle.close();
      }
      await expect(
        fileSystem.inspectPathNoFollow(join(directory, "missing.json")),
      ).resolves.toEqual({ kind: "missing" });
    });

    it("reads exact inclusive bounds, distinguishes empty and missing, and refuses symlinks", async () => {
      const directory = temporaryDirectory();
      const exactPath = join(directory, "exact.bin");
      const oversizedPath = join(directory, "oversized.bin");
      const emptyPath = join(directory, "empty.bin");
      const linkPath = join(directory, "link.bin");
      writeFileSync(exactPath, "1234");
      writeFileSync(oversizedPath, "12345");
      writeFileSync(emptyPath, "");
      symlinkSync(exactPath, linkPath);
      const fileSystem = createNodeFileSystem();

      const exact = await fileSystem.openReadNoFollow(exactPath);
      try {
        await expect(exact.readAll(4)).resolves.toEqual(
          Uint8Array.from([49, 50, 51, 52]),
        );
      } finally {
        await exact.close();
      }

      const oversized = await fileSystem.openReadNoFollow(oversizedPath);
      try {
        await expectFileSystemError(oversized.readAll(4), "LIMIT_EXCEEDED");
      } finally {
        await oversized.close();
      }

      const empty = await fileSystem.openReadNoFollow(emptyPath);
      try {
        await expect(empty.readAll(0)).resolves.toEqual(new Uint8Array());
      } finally {
        await empty.close();
      }

      await expectFileSystemError(
        fileSystem.openReadNoFollow(join(directory, "missing.bin")),
        "NOT_FOUND",
      );
      await expectFileSystemError(
        fileSystem.openReadNoFollow(linkPath),
        "SYMBOLIC_LINK",
      );
    });

    it("creates exclusively without touching an existing file or symlink", async () => {
      const directory = temporaryDirectory();
      const existingPath = join(directory, "existing.lock");
      const targetPath = join(directory, "target.lock");
      const linkPath = join(directory, "link.lock");
      writeFileSync(existingPath, "owner-one", { mode: 0o600 });
      writeFileSync(targetPath, "target", { mode: 0o600 });
      symlinkSync(targetPath, linkPath);
      const fileSystem = createNodeFileSystem();

      await expectFileSystemError(
        fileSystem.createExclusiveNoFollow(existingPath, 0o600),
        "ALREADY_EXISTS",
      );
      await expectFileSystemError(
        fileSystem.createExclusiveNoFollow(linkPath, 0o600),
        "ALREADY_EXISTS",
      );
      expect(readFileSync(existingPath, "utf8")).toBe("owner-one");
      expect(readFileSync(targetPath, "utf8")).toBe("target");
      expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    });

    it("keeps reads and identity bound to the opened descriptor across a path replacement", async () => {
      const directory = temporaryDirectory();
      const path = join(directory, "state.lock");
      const displacedPath = join(directory, "state.lock.displaced");
      writeFileSync(path, "original", { mode: 0o600 });
      const fileSystem = createNodeFileSystem();
      const handle = await fileSystem.openReadNoFollow(path);
      try {
        const openedStat = await handle.stat();
        renameSync(path, displacedPath);
        writeFileSync(path, "replacement", { mode: 0o600 });

        await expect(handle.readAll(32)).resolves.toEqual(
          new TextEncoder().encode("original"),
        );
        const replacementStat = await fileSystem.inspectPathNoFollow(path);
        expect(replacementStat.kind).toBe("regular-file");
        if (replacementStat.kind === "missing") {
          throw new Error("The replacement fixture must exist.");
        }
        expect({
          dev: replacementStat.dev,
          ino: replacementStat.ino,
        }).not.toEqual({ dev: openedStat.dev, ino: openedStat.ino });
      } finally {
        await handle.close();
      }
    });

    it("writes, preserves requested metadata, flushes, renames, and unlinks through handles", async () => {
      const directory = temporaryDirectory();
      const temporaryPath = join(directory, "temporary.json");
      const targetPath = join(directory, "config.json");
      const fileSystem = createNodeFileSystem();
      const handle = await fileSystem.createExclusiveNoFollow(
        temporaryPath,
        0o600,
      );
      try {
        await handle.writeAll(new TextEncoder().encode('{"ok":true}\n'));
        await handle.chmod(0o640);
        if (process.getuid !== undefined && process.getgid !== undefined) {
          await handle.chown(process.getuid(), process.getgid());
        }
        await handle.sync();
        const metadata = await handle.stat();
        expect(metadata.kind).toBe("regular-file");
        expect(metadata.mode & 0o777).toBe(0o640);
      } finally {
        await handle.close();
      }

      await fileSystem.rename(temporaryPath, targetPath);
      expect(readFileSync(targetPath, "utf8")).toBe('{"ok":true}\n');
      expect(statSync(targetPath).mode & 0o777).toBe(0o640);
      await fileSystem.unlink(targetPath);
      expect(() => lstatSync(targetPath)).toThrow();
    });

    it("creates private directories and enforces the write and argument bounds", async () => {
      const directory = temporaryDirectory();
      const privatePath = join(directory, "private");
      const fileSystem = createNodeFileSystem();
      await fileSystem.mkdir(privatePath, 0o700);
      expect(statSync(privatePath).mode & 0o777).toBe(0o700);

      const outputPath = join(privatePath, "bounded.bin");
      const handle = await fileSystem.createExclusiveNoFollow(
        outputPath,
        0o600,
      );
      try {
        await handle.writeAll(new Uint8Array(maximumInstallerFileBytes));
        await expectFileSystemError(
          handle.writeAll(Uint8Array.of(1)),
          "LIMIT_EXCEEDED",
        );
      } finally {
        await handle.close();
      }
      expect(statSync(outputPath).size).toBe(maximumInstallerFileBytes);

      mkdirSync(join(directory, "existing"));
      await expectFileSystemError(
        fileSystem.mkdir(join(directory, "existing"), 0o700),
        "ALREADY_EXISTS",
      );
    });
  },
);
