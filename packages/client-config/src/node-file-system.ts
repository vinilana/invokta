import { type BigIntStats, constants, type Stats } from "node:fs";
import {
  chmod,
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";

import {
  type InstallerDirectoryReader,
  type InstallerFileStat,
  InstallerFileSystemError,
  type InstallerReadHandle,
  type InstallerTransactionFileSystem,
  type InstallerWriteHandle,
  maximumInstallerFileBytes,
} from "./file-system.js";

const readChunkBytes = 65_536;

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}

function normalizeFileSystemError(error: unknown): InstallerFileSystemError {
  if (error instanceof InstallerFileSystemError) return error;
  const code = errorCode(error);
  if (code === "EEXIST") {
    return new InstallerFileSystemError("ALREADY_EXISTS", error);
  }
  if (code === "ENOENT") {
    return new InstallerFileSystemError("NOT_FOUND", error);
  }
  if (code === "ELOOP") {
    return new InstallerFileSystemError("SYMBOLIC_LINK", error);
  }
  return new InstallerFileSystemError("IO_FAILED", error);
}

async function normalized<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw normalizeFileSystemError(error);
  }
}

function fileKind(status: Stats | BigIntStats): InstallerFileStat["kind"] {
  if (status.isFile()) return "regular-file";
  if (status.isDirectory()) return "directory";
  if (status.isSymbolicLink()) return "symbolic-link";
  return "other";
}

function safeMetadataNumber(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new InstallerFileSystemError("IO_FAILED");
  }
  return number;
}

function toFileStat(status: BigIntStats): InstallerFileStat {
  return Object.freeze({
    kind: fileKind(status),
    dev: status.dev,
    ino: status.ino,
    uid: safeMetadataNumber(status.uid),
    gid: safeMetadataNumber(status.gid),
    mode: safeMetadataNumber(status.mode),
  });
}

function validateMode(mode: number): void {
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) {
    throw new InstallerFileSystemError("INVALID_ARGUMENT");
  }
}

function validateId(id: number): void {
  if (!Number.isSafeInteger(id) || id < 0) {
    throw new InstallerFileSystemError("INVALID_ARGUMENT");
  }
}

function currentUserId(): number {
  if (process.getuid === undefined) {
    throw new InstallerFileSystemError("IO_FAILED");
  }
  const uid = process.getuid();
  validateId(uid);
  return uid;
}

function sameObjectIdentity(
  expected: InstallerFileStat,
  current: InstallerFileStat,
): boolean {
  return (
    expected.kind === current.kind &&
    expected.dev === current.dev &&
    expected.ino === current.ino &&
    expected.uid === current.uid &&
    expected.gid === current.gid
  );
}

async function lstatIdentity(
  path: string,
): Promise<InstallerFileStat | undefined> {
  try {
    return toFileStat(await lstat(path, { bigint: true }));
  } catch {
    return undefined;
  }
}

async function closeAfterSetupFailure(handle: FileHandle): Promise<void> {
  try {
    await handle.close();
  } catch {
    // Cleanup remains identity-conditional even when descriptor close fails.
  }
}

async function unlinkCreatedFile(
  path: string,
  created: InstallerFileStat,
): Promise<void> {
  const current = await lstatIdentity(path);
  if (
    current === undefined ||
    current.kind !== "regular-file" ||
    !sameObjectIdentity(created, current)
  ) {
    return;
  }
  try {
    await unlink(path);
  } catch {
    // A changed or non-removable path is preserved for manual inspection.
  }
}

async function removeCreatedDirectory(
  path: string,
  created: InstallerFileStat,
): Promise<void> {
  const current = await lstatIdentity(path);
  if (
    current === undefined ||
    current.kind !== "directory" ||
    !sameObjectIdentity(created, current)
  ) {
    return;
  }
  try {
    await rmdir(path);
  } catch {
    // Never recurse: a nonempty or changed directory may contain user data.
  }
}

async function handleStat(handle: FileHandle): Promise<InstallerFileStat> {
  return normalized(async () =>
    toFileStat(await handle.stat({ bigint: true })),
  );
}

function closeHandle(handle: FileHandle): () => Promise<void> {
  let closed = false;
  return async () => {
    if (closed) return;
    closed = true;
    await normalized(() => handle.close());
  };
}

function readHandle(handle: FileHandle): InstallerReadHandle {
  return Object.freeze({
    readAll: async (maxBytes: number) => {
      if (
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 0 ||
        maxBytes > maximumInstallerFileBytes
      ) {
        throw new InstallerFileSystemError("INVALID_ARGUMENT");
      }
      return normalized(async () => {
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (true) {
          const requested =
            total === maxBytes ? 1 : Math.min(readChunkBytes, maxBytes - total);
          const chunk = new Uint8Array(requested);
          const { bytesRead } = await handle.read(chunk, 0, requested, total);
          if (bytesRead === 0) {
            const result = new Uint8Array(total);
            let offset = 0;
            for (const buffered of chunks) {
              result.set(buffered, offset);
              offset += buffered.byteLength;
            }
            return result;
          }
          if (total + bytesRead > maxBytes) {
            throw new InstallerFileSystemError("LIMIT_EXCEEDED");
          }
          chunks.push(chunk.subarray(0, bytesRead));
          total += bytesRead;
        }
      });
    },
    stat: () => handleStat(handle),
    close: closeHandle(handle),
  });
}

function writeHandle(handle: FileHandle): InstallerWriteHandle {
  let position = 0;
  return Object.freeze({
    writeAll: async (bytes: Uint8Array) => {
      if (!(bytes instanceof Uint8Array)) {
        throw new InstallerFileSystemError("INVALID_ARGUMENT");
      }
      if (bytes.byteLength > maximumInstallerFileBytes - position) {
        throw new InstallerFileSystemError("LIMIT_EXCEEDED");
      }
      await normalized(async () => {
        let offset = 0;
        while (offset < bytes.byteLength) {
          const { bytesWritten } = await handle.write(
            bytes,
            offset,
            bytes.byteLength - offset,
            position,
          );
          if (bytesWritten === 0) {
            throw new InstallerFileSystemError("IO_FAILED");
          }
          offset += bytesWritten;
          position += bytesWritten;
        }
      });
    },
    chmod: async (mode: number) => {
      validateMode(mode);
      await normalized(() => handle.chmod(mode));
    },
    chown: async (uid: number, gid: number) => {
      validateId(uid);
      validateId(gid);
      await normalized(() => handle.chown(uid, gid));
    },
    sync: () => normalized(() => handle.sync()),
    stat: () => handleStat(handle),
    close: closeHandle(handle),
  });
}

export interface CreateNodeFileSystemOptions {
  readonly platform?: NodeJS.Platform;
}

/**
 * Windows has no `O_NOFOLLOW`, no ACL access through Node, and no meaningful
 * permission bits, so the three no-follow operations take a different shape
 * there: inspect first, reject a reparse point, then open. That check is not
 * atomic, which is precisely the assurance difference ADR 0019 records between
 * the `posix` and `windows` contracts.
 */
export function createNodeFileSystem(
  options: CreateNodeFileSystemOptions = {},
): InstallerTransactionFileSystem & InstallerDirectoryReader {
  const windows = (options.platform ?? process.platform) === "win32";
  return {
    readFile: async (path) => readFile(path),
    readDirectory: async (path) => {
      const entries = await normalized(() =>
        readdir(path, { withFileTypes: true }),
      );
      return Object.freeze(
        entries.map((entry) =>
          Object.freeze({
            name: entry.name,
            kind: entry.isDirectory()
              ? ("directory" as const)
              : entry.isFile()
                ? ("regular-file" as const)
                : entry.isSymbolicLink()
                  ? ("symbolic-link" as const)
                  : ("other" as const),
          }),
        ),
      );
    },
    inspectPath: async (path) => {
      try {
        const status = await lstat(path);
        if (status.isSymbolicLink()) {
          return { kind: "symbolic-link", ownerId: status.uid };
        }
        if (status.isFile() || status.isDirectory()) {
          return {
            kind: status.isFile() ? "regular-file" : "directory",
            ownerId: status.uid,
            realPath: await realpath(path),
          };
        }
        return { kind: "other", ownerId: status.uid };
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return { kind: "missing" };
        }
        throw error;
      }
    },
    inspectPathNoFollow: async (path) => {
      try {
        return toFileStat(await lstat(path, { bigint: true }));
      } catch (error) {
        if (errorCode(error) === "ENOENT") return { kind: "missing" };
        throw normalizeFileSystemError(error);
      }
    },
    openReadNoFollow: async (path) =>
      normalized(async () => {
        if (windows) {
          const existing = await lstatIdentity(path);
          if (existing === undefined) {
            throw new InstallerFileSystemError("NOT_FOUND");
          }
          if (existing.kind === "symbolic-link") {
            throw new InstallerFileSystemError("SYMBOLIC_LINK");
          }
          return readHandle(await open(path, constants.O_RDONLY));
        }
        return readHandle(
          await open(
            path,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          ),
        );
      }),
    createExclusiveNoFollow: async (path, mode) => {
      validateMode(mode);
      if (windows) {
        return normalized(async () => {
          const handle = await open(
            path,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
            mode,
          );
          try {
            const created = await handleStat(handle);
            if (created.kind !== "regular-file") {
              throw new InstallerFileSystemError("IO_FAILED");
            }
            return writeHandle(handle);
          } catch (error) {
            await closeAfterSetupFailure(handle);
            throw error;
          }
        });
      }
      return normalized(async () => {
        const handle = await open(
          path,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          mode,
        );
        let created: InstallerFileStat | undefined;
        try {
          created = await handleStat(handle);
          if (
            created.kind !== "regular-file" ||
            created.uid !== currentUserId()
          ) {
            throw new InstallerFileSystemError("IO_FAILED");
          }
          await handle.chmod(mode);
          const configured = await handleStat(handle);
          if (
            !sameObjectIdentity(created, configured) ||
            (configured.mode & 0o7777) !== mode
          ) {
            throw new InstallerFileSystemError("IO_FAILED");
          }
          return writeHandle(handle);
        } catch (error) {
          await closeAfterSetupFailure(handle);
          if (created !== undefined) {
            await unlinkCreatedFile(path, created);
          }
          throw error;
        }
      });
    },
    mkdir: async (path, mode) => {
      validateMode(mode);
      if (windows) {
        await normalized(async () => {
          await mkdir(path, { mode });
          const created = await lstatIdentity(path);
          if (created === undefined || created.kind !== "directory") {
            throw new InstallerFileSystemError("IO_FAILED");
          }
        });
        return;
      }
      await normalized(async () => {
        await mkdir(path, { mode });
        let created: InstallerFileStat | undefined;
        try {
          const initial = await lstatIdentity(path);
          if (
            initial === undefined ||
            initial.kind !== "directory" ||
            initial.uid !== currentUserId()
          ) {
            throw new InstallerFileSystemError("IO_FAILED");
          }
          created = initial;
          await chmod(path, mode);
          const configured = await lstatIdentity(path);
          if (
            configured === undefined ||
            !sameObjectIdentity(created, configured) ||
            (configured.mode & 0o7777) !== mode
          ) {
            throw new InstallerFileSystemError("IO_FAILED");
          }
          const handle = await open(
            path,
            constants.O_RDONLY |
              constants.O_DIRECTORY |
              constants.O_NOFOLLOW |
              constants.O_NONBLOCK,
          );
          try {
            const descriptor = await handleStat(handle);
            if (
              !sameObjectIdentity(created, descriptor) ||
              (descriptor.mode & 0o7777) !== mode
            ) {
              throw new InstallerFileSystemError("IO_FAILED");
            }
          } finally {
            await handle.close();
          }
        } catch (error) {
          if (created !== undefined) {
            await removeCreatedDirectory(path, created);
          }
          throw error;
        }
      });
    },
    rename: (from, to) => normalized(() => rename(from, to)),
    unlink: (path) => normalized(() => unlink(path)),
  };
}
