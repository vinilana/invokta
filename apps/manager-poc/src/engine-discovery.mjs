/**
 * Finds Action Engine projects on this machine by looking for the
 * `invokta.mcp.json` manifest that `create-invokta-engine` generates.
 *
 * Discovery is a convenience layer only. It reads the manifest with a plain
 * JSON parse so the console can show a project that is not installed anywhere
 * yet. The authoritative validation always runs later, inside the installer,
 * when the project is actually installed.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const manifestName = "invokta.mcp.json";
const maximumDepth = 4;
const maximumDirectories = 20_000;
const skippedDirectories = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  "out",
  "target",
  "vendor",
  "tmp",
]);

const conventionalRoots = [
  "workspace",
  "workspaces",
  "projects",
  "Projects",
  "code",
  "dev",
  "src",
  "repos",
];

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** The directories scanned when the operator passes no explicit `--scan`. */
export async function defaultScanRoots(workingDirectory) {
  const home = homedir();
  const candidates = [
    workingDirectory,
    ...conventionalRoots.map((name) => join(home, name)),
  ];
  const roots = [];
  for (const candidate of candidates) {
    const path = resolve(candidate);
    if (
      roots.some(
        (existing) => path === existing || path.startsWith(`${existing}/`),
      )
    ) {
      continue;
    }
    if (await isDirectory(path)) roots.push(path);
  }
  return roots;
}

async function readManifest(manifestPath, projectDirectory) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (cause) {
    return {
      projectDirectory,
      manifestPath,
      valid: false,
      reason: cause instanceof Error ? cause.message : "unreadable manifest",
    };
  }
  const server = parsed?.server ?? {};
  if (typeof parsed?.id !== "string" || typeof server.name !== "string") {
    return {
      projectDirectory,
      manifestPath,
      valid: false,
      reason: "manifest is missing an id or a server name",
    };
  }
  const entrypoint =
    typeof server.entrypoint === "string" ? server.entrypoint : undefined;
  const entrypointPath =
    entrypoint === undefined ? undefined : join(projectDirectory, entrypoint);
  return {
    projectDirectory,
    manifestPath,
    valid: true,
    id: parsed.id,
    version: typeof parsed.version === "string" ? parsed.version : "0.0.0",
    title: typeof parsed.title === "string" ? parsed.title : parsed.id,
    description:
      typeof parsed.description === "string" ? parsed.description : "",
    capabilityIds: Array.isArray(parsed.capabilityIds)
      ? parsed.capabilityIds
      : [],
    serverName: server.name,
    entrypoint,
    entrypointPath,
    entrypointBuilt:
      entrypointPath === undefined ? false : await fileExists(entrypointPath),
    forwardEnv: Array.isArray(server.forwardEnv) ? server.forwardEnv : [],
  };
}

/**
 * Bounded breadth-first scan. Hidden directories, dependency directories, and
 * build output are skipped, and the traversal stops at a fixed depth and
 * directory budget so an unexpected root cannot make the console hang.
 */
export async function discoverEngineProjects(roots) {
  const queue = roots.map((path) => ({ path, depth: 0 }));
  const visited = new Set();
  const projects = [];
  let inspected = 0;

  while (queue.length > 0 && inspected < maximumDirectories) {
    const { path, depth } = queue.shift();
    if (visited.has(path)) continue;
    visited.add(path);
    inspected += 1;

    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      continue;
    }

    if (
      entries.some((entry) => entry.isFile() && entry.name === manifestName)
    ) {
      projects.push(await readManifest(join(path, manifestName), path));
    }
    if (depth >= maximumDepth) continue;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;
      if (skippedDirectories.has(entry.name)) continue;
      queue.push({ path: join(path, entry.name), depth: depth + 1 });
    }
  }

  return {
    roots,
    inspected,
    truncated: inspected >= maximumDirectories,
    projects: projects.sort((left, right) =>
      basename(left.projectDirectory).localeCompare(
        basename(right.projectDirectory),
      ),
    ),
  };
}
