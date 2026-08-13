import type {
  InstallerFileStat,
  InstallerReadHandle,
  InstallerTransactionFileSystem,
  InstallerWriteHandle,
} from "../src/file-system.js";
import type { InstallerOwnershipIdentity } from "../src/ownership-identity.js";

export const windowsPrincipal: InstallerOwnershipIdentity = Object.freeze({
  kind: "windows-principal",
  reportedOwnerId: 0,
});

/** Maps a POSIX stat to the shape Node reports for the same object on Windows. */
function windowsStat(stat: InstallerFileStat): InstallerFileStat {
  const permissions = (stat.mode & 0o200) === 0 ? 0o444 : 0o666;
  return Object.freeze({
    ...stat,
    uid: 0,
    gid: 0,
    mode: (stat.mode & ~0o7777) | permissions,
  });
}

function windowsReadHandle(handle: InstallerReadHandle): InstallerReadHandle {
  return Object.freeze({
    readAll: (maxBytes: number) => handle.readAll(maxBytes),
    stat: async () => windowsStat(await handle.stat()),
    close: () => handle.close(),
  });
}

function windowsWriteHandle(
  handle: InstallerWriteHandle,
): InstallerWriteHandle {
  return Object.freeze({
    writeAll: (bytes: Uint8Array) => handle.writeAll(bytes),
    chmod: (mode: number) => handle.chmod(mode),
    // libuv implements chown as a successful no-op on Windows.
    chown: async () => undefined,
    sync: () => handle.sync(),
    stat: async () => windowsStat(await handle.stat()),
    close: () => handle.close(),
  });
}

/**
 * Presents a POSIX transaction file system the way Node exposes the local
 * file system on Windows: every object reports owner id `0`, modes carry only
 * the read-only distinction, and `chown` succeeds without effect.
 */
export function createWindowsLikeFileSystem(
  base: InstallerTransactionFileSystem,
): InstallerTransactionFileSystem {
  return Object.freeze({
    readFile: (path: URL) => base.readFile(path),
    inspectPath: async (path: string) => {
      const inspection = await base.inspectPath(path);
      return inspection.kind === "missing"
        ? inspection
        : Object.freeze({ ...inspection, ownerId: 0 });
    },
    inspectPathNoFollow: async (path: string) => {
      const inspection = await base.inspectPathNoFollow(path);
      return inspection.kind === "missing"
        ? inspection
        : windowsStat(inspection);
    },
    openReadNoFollow: async (path: string) =>
      windowsReadHandle(await base.openReadNoFollow(path)),
    createExclusiveNoFollow: async (path: string, mode: number) =>
      windowsWriteHandle(await base.createExclusiveNoFollow(path, mode)),
    mkdir: (path: string, mode: number) => base.mkdir(path, mode),
    rename: (from: string, to: string) => base.rename(from, to),
    unlink: (path: string) => base.unlink(path),
  });
}
