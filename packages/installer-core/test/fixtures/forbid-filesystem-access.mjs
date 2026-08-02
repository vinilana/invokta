import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

function forbidFilesystemAccess() {
  throw new Error("INSTALLER_FILESYSTEM_ACCESS_FORBIDDEN");
}

const directCandidates = [
  "access",
  "accessSync",
  "createReadStream",
  "existsSync",
  "lstat",
  "lstatSync",
  "open",
  "openSync",
  "read",
  "readFile",
  "readFileSync",
  "readSync",
  "readdir",
  "readdirSync",
  "readlink",
  "readlinkSync",
  "realpath",
  "realpathSync",
  "stat",
  "statSync",
];
const promiseCandidates = [
  "access",
  "lstat",
  "open",
  "readFile",
  "readdir",
  "readlink",
  "realpath",
  "stat",
];

for (const method of directCandidates) {
  if (typeof fs[method] === "function") fs[method] = forbidFilesystemAccess;
}
for (const method of promiseCandidates) {
  if (typeof fsPromises[method] === "function") {
    fsPromises[method] = forbidFilesystemAccess;
  }
}
syncBuiltinESMExports();

for (const [scope, target, method] of [
  ["fs", fs, "readFileSync"],
  ["fsPromises", fsPromises, "readFile"],
]) {
  try {
    target[method]("filesystem-access-sentinel-probe");
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "INSTALLER_FILESYSTEM_ACCESS_FORBIDDEN"
    ) {
      continue;
    }
    throw error;
  }
  throw new Error(`FILESYSTEM_ACCESS_SENTINEL_SELF_PROBE_FAILED:${scope}`);
}
