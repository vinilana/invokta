/**
 * Where the console looks for Action Engine projects when nobody says.
 *
 * The conventional names are deliberately plain directory names, so the same
 * list works on Linux, macOS, and Windows. An explicit `--scan` always wins;
 * this is only the zero-configuration starting point.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { InstallerFileSystem } from "@invokta/installer-core";

const conventionalNames = Object.freeze([
  "workspace",
  "workspaces",
  "projects",
  "Projects",
  "code",
  "dev",
  "src",
  "repos",
  join("source", "repos"),
]);

export interface DefaultScanRootsOptions {
  readonly fileSystem: InstallerFileSystem;
  readonly workingDirectory: string;
  readonly homeDirectory?: string;
}

export async function defaultScanRoots(
  options: DefaultScanRootsOptions,
): Promise<readonly string[]> {
  const home = options.homeDirectory ?? homedir();
  const candidates = [
    options.workingDirectory,
    ...conventionalNames.map((name) => join(home, name)),
  ];
  const roots: string[] = [];
  for (const candidate of candidates) {
    const path = resolve(candidate);
    if (roots.includes(path)) continue;
    try {
      const inspection = await options.fileSystem.inspectPath(path);
      if (inspection.kind === "directory") roots.push(path);
    } catch {
      // An unreadable candidate is simply not a scan root.
    }
  }
  return Object.freeze(roots);
}
