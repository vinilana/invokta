import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, resolve } from "node:path";

import type {
  ExecutableResolver,
  OperatingSystemHomeResolver,
} from "./harness-detection.js";

export interface NodeExecutableResolverOptions {
  readonly pathValue?: string;
}

export const resolveNodeOperatingSystemHome: OperatingSystemHomeResolver = () =>
  homedir();

export function createNodeExecutableResolver(
  options: NodeExecutableResolverOptions = {},
): ExecutableResolver {
  const pathValue = options.pathValue ?? process.env.PATH;
  const searchDirectories =
    pathValue === undefined ? [] : pathValue.split(delimiter);

  return async (candidate) => {
    if (
      candidate === "" ||
      candidate.includes("/") ||
      candidate.includes("\\")
    ) {
      return undefined;
    }
    for (const directory of searchDirectories) {
      const path = resolve(directory === "" ? "." : directory, candidate);
      try {
        const metadata = await stat(path);
        if (!metadata.isFile() || (metadata.mode & 0o111) === 0) continue;
        await access(path, constants.X_OK);
        const resolvedPath = await realpath(path);
        return Object.freeze({
          path,
          identity: Object.freeze({
            device: metadata.dev,
            inode: metadata.ino,
            realPath: resolvedPath,
          }),
          ...(candidate === "antigravity" && basename(resolvedPath) === "agy"
            ? { legacyAliasFor: "agy" as const }
            : {}),
        });
      } catch {
        // A missing, unreadable, or non-executable PATH candidate is no evidence.
      }
    }
    return undefined;
  };
}
