/**
 * Finds Action Engine projects by their `invokta.mcp.json` manifest.
 *
 * Discovery exists so the inventory can show a project that is not registered
 * anywhere yet. It is read-only, bounded in depth and in the number of
 * directories it visits, and it reports truncation rather than silently
 * stopping. Every manifest is validated by the same loader an install uses, so
 * a project that discovery accepts is a project the installer would accept.
 */

import { isAbsolute, join, resolve } from "node:path";

import {
  type EngineProjectMetadata,
  loadEngineProjectMetadata,
} from "./engine-manifest.js";
import type {
  InstallerDirectoryReader,
  InstallerTransactionFileSystem,
} from "./file-system.js";
import { InstallerError, type InstallerErrorCode } from "./installer-error.js";
import type { PathSafetyContract } from "./path-contract.js";

export const engineManifestFileName = "invokta.mcp.json";
export const defaultDiscoveryDepth = 4;
export const defaultDiscoveryDirectoryLimit = 20_000;

const skippedDirectoryNames = Object.freeze(
  new Set([
    "node_modules",
    "dist",
    "build",
    "coverage",
    "out",
    "target",
    "vendor",
    "tmp",
  ]),
);

export interface RejectedEngineProject {
  readonly projectDirectory: string;
  readonly code: InstallerErrorCode;
}

export interface EngineProjectDiscovery {
  readonly roots: readonly string[];
  readonly inspectedDirectories: number;
  readonly truncated: boolean;
  readonly projects: readonly EngineProjectMetadata[];
  readonly rejected: readonly RejectedEngineProject[];
}

export interface DiscoverEngineProjectsOptions {
  readonly currentUserId: number;
  /** Defaults to the POSIX contract for `currentUserId`. */
  readonly contract?: PathSafetyContract;
  readonly directoryReader: InstallerDirectoryReader;
  readonly fileSystem: InstallerTransactionFileSystem;
  readonly roots: readonly string[];
  readonly maximumDepth?: number;
  readonly maximumDirectories?: number;
}

function normalizeRoots(roots: readonly string[]): readonly string[] {
  const normalized: string[] = [];
  for (const candidate of roots) {
    if (!isAbsolute(candidate) || candidate.includes("\0")) {
      throw new InstallerError("ENGINE_PATH_UNSAFE");
    }
    const path = resolve(candidate);
    const contained = normalized.some(
      (existing) => path === existing || path.startsWith(`${existing}/`),
    );
    if (!contained) normalized.push(path);
  }
  return Object.freeze(normalized);
}

export async function discoverEngineProjects(
  options: DiscoverEngineProjectsOptions,
): Promise<EngineProjectDiscovery> {
  const roots = normalizeRoots(options.roots);
  const maximumDepth = options.maximumDepth ?? defaultDiscoveryDepth;
  const maximumDirectories =
    options.maximumDirectories ?? defaultDiscoveryDirectoryLimit;

  const queue = roots.map((path) => ({ path, depth: 0 }));
  const visited = new Set<string>();
  const projects: EngineProjectMetadata[] = [];
  const rejected: RejectedEngineProject[] = [];
  let inspectedDirectories = 0;

  while (queue.length > 0 && inspectedDirectories < maximumDirectories) {
    const next = queue.shift();
    if (next === undefined) break;
    if (visited.has(next.path)) continue;
    visited.add(next.path);
    inspectedDirectories += 1;

    let entries: Awaited<ReturnType<InstallerDirectoryReader["readDirectory"]>>;
    try {
      entries = await options.directoryReader.readDirectory(next.path);
    } catch {
      // An unreadable directory is not evidence of anything.
      continue;
    }

    if (
      entries.some(
        (entry) =>
          entry.kind === "regular-file" &&
          entry.name === engineManifestFileName,
      )
    ) {
      try {
        projects.push(
          await loadEngineProjectMetadata({
            currentUserId: options.currentUserId,
            ...(options.contract === undefined
              ? {}
              : { contract: options.contract }),
            fileSystem: options.fileSystem,
            projectDirectory: next.path,
          }),
        );
      } catch (cause) {
        rejected.push(
          Object.freeze({
            projectDirectory: next.path,
            code:
              cause instanceof InstallerError
                ? cause.code
                : "ENGINE_MANIFEST_INVALID",
          }),
        );
      }
    }

    if (next.depth >= maximumDepth) continue;
    for (const entry of entries) {
      if (entry.kind !== "directory") continue;
      if (entry.name.startsWith(".")) continue;
      if (skippedDirectoryNames.has(entry.name)) continue;
      queue.push({ path: join(next.path, entry.name), depth: next.depth + 1 });
    }
  }

  return Object.freeze({
    roots,
    inspectedDirectories,
    truncated: queue.length > 0,
    projects: Object.freeze(
      [...projects].sort((left, right) =>
        left.manifest.id.localeCompare(right.manifest.id),
      ),
    ),
    rejected: Object.freeze(rejected),
  });
}
