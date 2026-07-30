import type { Stats } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, win32 } from "node:path";

import { CreatorError } from "./errors.js";
import type { PackageManager } from "./package-manager.js";
import { createStarterFiles, type StarterEntry } from "./starter.js";

export const creatorTargetLimits = Object.freeze({
  maxPathScalars: 1_024,
  maxPathSegments: 32,
  maxProjectNameCharacters: 214,
});

const projectNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export interface ScaffoldFileSystem {
  readonly lstat: (path: string) => Promise<Stats>;
  readonly mkdir: (path: string) => Promise<void>;
  readonly readdir: (path: string) => Promise<string[]>;
  readonly rmdir: (path: string) => Promise<void>;
  readonly symlink: (target: string, path: string) => Promise<void>;
  readonly unlink: (path: string) => Promise<void>;
  readonly writeFile: (
    path: string,
    contents: string,
    options: Readonly<{ encoding: "utf8"; flag: "wx" }>,
  ) => Promise<void>;
}

const nodeScaffoldFileSystem: ScaffoldFileSystem = {
  lstat,
  async mkdir(path) {
    await mkdir(path);
  },
  async readdir(path) {
    return readdir(path);
  },
  async rmdir(path) {
    await rmdir(path);
  },
  async symlink(target, path) {
    await symlink(target, path);
  },
  async unlink(path) {
    await unlink(path);
  },
  async writeFile(path, contents, options) {
    await writeFile(path, contents, options);
  },
};

export const defaultScaffoldFileSystem: ScaffoldFileSystem = Object.freeze(
  nodeScaffoldFileSystem,
);

export interface CreateStarterProjectOptions {
  readonly cwd: string;
  readonly target: string;
  readonly invoktaVersion: string;
  readonly packageManager: PackageManager;
  readonly fileSystem?: ScaffoldFileSystem;
}

export interface StarterProject {
  readonly directory: string;
  readonly projectName: string;
  readonly files: readonly string[];
}

interface ResolvedTarget {
  readonly directory: string;
  readonly projectName: string;
  readonly segments: readonly string[];
}

function countScalars(value: string): number {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
}

function readErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function invalidTarget(): never {
  throw new CreatorError("TARGET_INVALID");
}

function resolveTarget(cwd: string, target: string): ResolvedTarget {
  if (
    target === "" ||
    target.includes("\u0000") ||
    countScalars(target) > creatorTargetLimits.maxPathScalars ||
    isAbsolute(target) ||
    win32.isAbsolute(target)
  ) {
    return invalidTarget();
  }

  const rawSegments = target.split(/[\\/]/u);
  if (target !== "." && rawSegments.some((segment) => segment === "")) {
    return invalidTarget();
  }
  const segments = rawSegments.filter((segment) => segment !== ".");
  if (
    segments.some((segment) => segment === "..") ||
    segments.length > creatorTargetLimits.maxPathSegments
  ) {
    return invalidTarget();
  }

  const directory =
    segments.length === 0 ? resolve(cwd) : resolve(cwd, ...segments);
  const projectName = basename(directory);
  if (
    projectName.length === 0 ||
    projectName.length > creatorTargetLimits.maxProjectNameCharacters ||
    !projectNamePattern.test(projectName)
  ) {
    return invalidTarget();
  }
  return { directory, projectName, segments };
}

async function readStatus(
  fileSystem: ScaffoldFileSystem,
  path: string,
): Promise<Stats | undefined> {
  try {
    return await fileSystem.lstat(path);
  } catch (error) {
    const code = readErrorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw new CreatorError("TARGET_UNSAFE");
  }
}

async function inspectTarget(
  cwd: string,
  target: ResolvedTarget,
  fileSystem: ScaffoldFileSystem,
): Promise<void> {
  let current = resolve(cwd);
  if (target.segments.length === 0) {
    const status = await readStatus(fileSystem, current);
    if (
      status === undefined ||
      status.isSymbolicLink() ||
      !status.isDirectory()
    ) {
      throw new CreatorError("TARGET_UNSAFE");
    }
  } else {
    for (const segment of target.segments) {
      current = join(current, segment);
      const status = await readStatus(fileSystem, current);
      if (status === undefined) return;
      if (status.isSymbolicLink() || !status.isDirectory()) {
        throw new CreatorError("TARGET_UNSAFE");
      }
    }
  }

  let entries: string[];
  try {
    entries = await fileSystem.readdir(target.directory);
  } catch {
    throw new CreatorError("TARGET_UNSAFE");
  }
  if (entries.length > 0) throw new CreatorError("TARGET_NOT_EMPTY");
}

async function ensureDirectory(
  path: string,
  fileSystem: ScaffoldFileSystem,
  createdDirectories: string[],
): Promise<void> {
  const status = await readStatus(fileSystem, path);
  if (status !== undefined) {
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new CreatorError("TARGET_UNSAFE");
    }
    return;
  }
  try {
    await fileSystem.mkdir(path);
    createdDirectories.push(path);
  } catch (error) {
    if (readErrorCode(error) !== "EEXIST") {
      throw new CreatorError("WRITE_FAILED");
    }
    const racedStatus = await readStatus(fileSystem, path);
    if (
      racedStatus === undefined ||
      racedStatus.isSymbolicLink() ||
      !racedStatus.isDirectory()
    ) {
      throw new CreatorError("TARGET_UNSAFE");
    }
  }
}

async function prepareDirectories(
  cwd: string,
  target: ResolvedTarget,
  entries: readonly StarterEntry[],
  fileSystem: ScaffoldFileSystem,
  createdDirectories: string[],
): Promise<void> {
  let current = resolve(cwd);
  for (const segment of target.segments) {
    current = join(current, segment);
    await ensureDirectory(current, fileSystem, createdDirectories);
  }
  for (const directory of new Set(
    entries
      .map((entry) => dirname(entry.path))
      .filter((path) => path !== ".")
      .sort(),
  )) {
    let nested = target.directory;
    for (const segment of directory.split("/")) {
      nested = join(nested, segment);
      await ensureDirectory(nested, fileSystem, createdDirectories);
    }
  }
}

async function rollback(
  fileSystem: ScaffoldFileSystem,
  createdEntries: readonly string[],
  createdDirectories: readonly string[],
): Promise<boolean> {
  let failed = false;
  for (const path of [...createdEntries].reverse()) {
    try {
      await fileSystem.unlink(path);
    } catch (error) {
      if (readErrorCode(error) !== "ENOENT") failed = true;
    }
  }
  for (const path of [...createdDirectories].reverse()) {
    try {
      await fileSystem.rmdir(path);
    } catch (error) {
      const code = readErrorCode(error);
      if (code !== "ENOENT" && code !== "ENOTEMPTY") failed = true;
    }
  }
  return !failed;
}

/** Creates the fixed starter without installing dependencies or replacing files. */
export async function createStarterProject(
  options: CreateStarterProjectOptions,
): Promise<StarterProject> {
  const fileSystem = options.fileSystem ?? defaultScaffoldFileSystem;
  const target = resolveTarget(options.cwd, options.target);
  await inspectTarget(options.cwd, target, fileSystem);
  const entries = createStarterFiles({
    projectName: target.projectName,
    invoktaVersion: options.invoktaVersion,
    packageManager: options.packageManager,
  });
  const createdEntries: string[] = [];
  const createdDirectories: string[] = [];
  let activeEntry: StarterEntry | undefined;

  try {
    await prepareDirectories(
      options.cwd,
      target,
      entries,
      fileSystem,
      createdDirectories,
    );
    for (const entry of entries) {
      activeEntry = entry;
      const path = join(target.directory, ...entry.path.split("/"));
      if (entry.kind === "file") {
        await fileSystem.writeFile(path, entry.contents, {
          encoding: "utf8",
          flag: "wx",
        });
      } else {
        await fileSystem.symlink(entry.target, path);
      }
      createdEntries.push(path);
    }
  } catch (error) {
    const rolledBack = await rollback(
      fileSystem,
      createdEntries,
      createdDirectories,
    );
    if (!rolledBack) throw new CreatorError("WRITE_FAILED");
    if (error instanceof CreatorError) throw error;
    if (readErrorCode(error) === "EEXIST") {
      throw new CreatorError(
        "SCAFFOLD_CONFLICT",
        activeEntry === undefined ? [] : [activeEntry.path],
      );
    }
    throw new CreatorError(
      "WRITE_FAILED",
      activeEntry === undefined ? [] : [activeEntry.path],
    );
  }

  return Object.freeze({
    directory: target.directory,
    projectName: target.projectName,
    files: Object.freeze(entries.map((entry) => entry.path)),
  });
}
