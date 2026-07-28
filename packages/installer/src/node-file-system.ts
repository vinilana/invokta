import { readFile } from "node:fs/promises";

import type { InstallerFileSystem } from "./file-system.js";

export function createNodeFileSystem(): InstallerFileSystem {
  return {
    readFile: async (path) => readFile(path),
  };
}
