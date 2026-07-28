import { lstat, readFile, realpath } from "node:fs/promises";

import type { InstallerFileSystem } from "./file-system.js";

export function createNodeFileSystem(): InstallerFileSystem {
  return {
    readFile: async (path) => readFile(path),
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
  };
}
