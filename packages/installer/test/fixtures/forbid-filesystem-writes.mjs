import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

const readHandle = await fsPromises.open(new URL(import.meta.url), "r");
const fileHandlePrototype = Object.getPrototypeOf(readHandle);
await readHandle.close();
const originalOpen = fs.open;
const originalOpenSync = fs.openSync;
const originalPromiseOpen = fsPromises.open;

function forbidFilesystemWrite() {
  throw new Error("INSTALLER_FILESYSTEM_WRITE_FORBIDDEN");
}

const directCandidates = [
  "appendFile",
  "appendFileSync",
  "chmod",
  "chmodSync",
  "fchmod",
  "fchmodSync",
  "chown",
  "chownSync",
  "fchown",
  "fchownSync",
  "lchown",
  "lchownSync",
  "copyFile",
  "copyFileSync",
  "cp",
  "cpSync",
  "createWriteStream",
  "fdatasync",
  "fdatasyncSync",
  "fsync",
  "fsyncSync",
  "ftruncate",
  "ftruncateSync",
  "futimes",
  "futimesSync",
  "link",
  "linkSync",
  "lutimes",
  "lutimesSync",
  "mkdir",
  "mkdirSync",
  "mkdtemp",
  "mkdtempSync",
  "open",
  "openSync",
  "rename",
  "renameSync",
  "rm",
  "rmSync",
  "rmdir",
  "rmdirSync",
  "symlink",
  "symlinkSync",
  "truncate",
  "truncateSync",
  "unlink",
  "unlinkSync",
  "utimes",
  "utimesSync",
  "write",
  "writeSync",
  "writeFile",
  "writeFileSync",
  "writev",
  "writevSync",
];

const promiseCandidates = [
  "appendFile",
  "chmod",
  "chown",
  "copyFile",
  "cp",
  "lchmod",
  "lchown",
  "link",
  "lutimes",
  "mkdir",
  "mkdtemp",
  "open",
  "rename",
  "rm",
  "rmdir",
  "symlink",
  "truncate",
  "unlink",
  "utimes",
  "writeFile",
];

const fileHandleCandidates = [
  "appendFile",
  "chmod",
  "chown",
  "createWriteStream",
  "datasync",
  "sync",
  "truncate",
  "utimes",
  "write",
  "writeFile",
  "writev",
];

function installGuards(target, candidates) {
  const installed = [];
  for (const method of candidates) {
    if (typeof target[method] !== "function") continue;
    target[method] = forbidFilesystemWrite;
    installed.push(method);
  }
  return installed;
}

function isReadOnlyOpenFlag(flags) {
  if (typeof flags === "string") return flags === "r" || flags === "rs";
  if (typeof flags !== "number") return false;
  const writeBits =
    fs.constants.O_WRONLY |
    fs.constants.O_RDWR |
    fs.constants.O_CREAT |
    fs.constants.O_TRUNC |
    fs.constants.O_APPEND;
  return (flags & writeBits) === 0;
}

const direct = installGuards(fs, directCandidates);
const promises = installGuards(fsPromises, promiseCandidates);
const fileHandle = installGuards(fileHandlePrototype, fileHandleCandidates);
fs.open = function guardedOpen(path, flags, ...rest) {
  if (!isReadOnlyOpenFlag(flags)) return forbidFilesystemWrite();
  return originalOpen.call(fs, path, flags, ...rest);
};
fs.openSync = function guardedOpenSync(path, flags, ...rest) {
  if (!isReadOnlyOpenFlag(flags)) return forbidFilesystemWrite();
  return originalOpenSync.call(fs, path, flags, ...rest);
};
fsPromises.open = function guardedPromiseOpen(path, flags, ...rest) {
  if (!isReadOnlyOpenFlag(flags)) return forbidFilesystemWrite();
  return originalPromiseOpen.call(fsPromises, path, flags, ...rest);
};
syncBuiltinESMExports();

function assertGuarded(scope, method, invoke) {
  try {
    invoke();
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "INSTALLER_FILESYSTEM_WRITE_FORBIDDEN"
    ) {
      return;
    }
    throw error;
  }
  throw new Error(`WRITE_SENTINEL_SELF_PROBE_FAILED:${scope}.${method}`);
}

for (const method of direct) {
  assertGuarded("fs", method, () =>
    method === "open" || method === "openSync"
      ? fs[method]("write-sentinel-probe", "w")
      : fs[method](),
  );
}
for (const method of promises) {
  assertGuarded("fsPromises", method, () =>
    method === "open"
      ? fsPromises[method]("write-sentinel-probe", "w")
      : fsPromises[method](),
  );
}
for (const method of fileHandle) {
  assertGuarded("FileHandle", method, () =>
    fileHandlePrototype[method].call(Object.create(null)),
  );
}

globalThis.__AI_ENGINE_WRITE_SENTINEL_REPORT__ = Object.freeze({
  direct: Object.freeze(direct),
  promises: Object.freeze(promises),
  fileHandle: Object.freeze(fileHandle),
});
