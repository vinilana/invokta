import { createWriteStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { x as extractTar } from "tar";

import { CreatorError } from "./errors.js";
import {
  assertCreatableStarterTarget,
  defaultScaffoldFileSystem,
  type ScaffoldFileSystem,
} from "./scaffold.js";

export const exampleLimits = Object.freeze({
  maxExampleScalars: 2_048,
  maxShortNameCharacters: 214,
  maxShortNameSegments: 8,
  maxExamplePathScalars: 1_024,
  maxExamplePathSegments: 32,
  fetchTimeoutMs: 60_000,
  maxArchiveBytes: 52_428_800,
  maxExtractedFiles: 10_000,
  maxFileBytes: 5_242_880,
});

export const officialExampleSource = Object.freeze({
  owner: "vinilana",
  repository: "invokta",
  branch: "main",
  directory: "examples",
});

const shortNamePattern =
  /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/u;

export interface ExampleRepoInfo {
  readonly owner: string;
  readonly repository: string;
  readonly branch: string;
  readonly filePath: string;
  readonly label: string;
}

export type ExampleFetch = (
  input: string,
  init?: Readonly<{
    method?: string;
    signal?: AbortSignal;
    redirect?: "error" | "follow" | "manual";
  }>,
) => Promise<Response>;

export interface CreateExampleProjectOptions {
  readonly cwd: string;
  readonly target: string;
  readonly example: string;
  readonly examplePath?: string;
  readonly fetch?: ExampleFetch;
  readonly fileSystem?: ScaffoldFileSystem;
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

function invalidExample(): never {
  throw new CreatorError("EXAMPLE_INVALID");
}

function unavailableExample(details: readonly string[] = []): never {
  throw new CreatorError("EXAMPLE_UNAVAILABLE", details);
}

function failedExample(details: readonly string[] = []): never {
  throw new CreatorError("EXAMPLE_FAILED", details);
}

function normalizeExamplePath(path: string): string {
  if (
    path === "" ||
    path.includes("\u0000") ||
    countScalars(path) > exampleLimits.maxExamplePathScalars
  ) {
    return invalidExample();
  }
  if (path.startsWith("/") || path.includes("\\")) return invalidExample();
  const segments = path.split("/");
  if (
    segments.length === 0 ||
    segments.length > exampleLimits.maxExamplePathSegments ||
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    return invalidExample();
  }
  return segments.join("/");
}

function exampleLabel(
  owner: string,
  repository: string,
  filePath: string,
): string {
  return filePath === ""
    ? `${owner}/${repository}`
    : `${owner}/${repository}/${filePath}`;
}

function stripGitSuffix(repository: string): string {
  return repository.endsWith(".git") ? repository.slice(0, -4) : repository;
}

function officialShortLabel(filePath: string): string | undefined {
  const prefix = `${officialExampleSource.directory}/`;
  if (!filePath.startsWith(prefix)) return undefined;
  return filePath.slice(prefix.length);
}

function parseGithubUrl(
  value: string,
  examplePath: string | undefined,
): ExampleRepoInfo | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    return undefined;
  }
  if (url.hostname !== "github.com") return undefined;
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  if (segments.length < 2) return undefined;
  const [owner, rawRepository, treeToken, ...rest] = segments;
  if (owner === undefined || rawRepository === undefined) return undefined;
  const repository = stripGitSuffix(rawRepository);
  if (owner === "" || repository === "") return undefined;
  const overridePath =
    examplePath === undefined ? undefined : normalizeExamplePath(examplePath);

  if (treeToken === undefined) {
    return Object.freeze({
      owner,
      repository,
      branch: "",
      filePath: overridePath ?? "",
      label: exampleLabel(owner, repository, overridePath ?? ""),
    });
  }

  if (treeToken !== "tree" || rest.length === 0) return undefined;
  const [branch, ...pathSegments] = rest;
  if (branch === undefined || branch === "") return undefined;
  const urlPath = pathSegments.join("/");
  const filePath =
    overridePath ?? (urlPath === "" ? "" : normalizeExamplePath(urlPath));
  const shortLabel =
    owner === officialExampleSource.owner &&
    repository === officialExampleSource.repository
      ? officialShortLabel(filePath)
      : undefined;
  return Object.freeze({
    owner,
    repository,
    branch,
    filePath,
    label: shortLabel ?? exampleLabel(owner, repository, filePath),
  });
}

function parseOfficialShortName(
  value: string,
  examplePath: string | undefined,
): ExampleRepoInfo | undefined {
  if (!shortNamePattern.test(value)) return undefined;
  if (
    value.length > exampleLimits.maxShortNameCharacters ||
    value.split("/").length > exampleLimits.maxShortNameSegments
  ) {
    return undefined;
  }
  const nestedPath =
    examplePath === undefined ? undefined : normalizeExamplePath(examplePath);
  const filePath =
    nestedPath === undefined
      ? `${officialExampleSource.directory}/${value}`
      : `${officialExampleSource.directory}/${value}/${nestedPath}`;
  return Object.freeze({
    owner: officialExampleSource.owner,
    repository: officialExampleSource.repository,
    branch: officialExampleSource.branch,
    filePath,
    label: value,
  });
}

/** Parses a local example reference without performing network I/O. */
export function parseExampleReference(
  example: string,
  examplePath?: string,
): ExampleRepoInfo {
  if (
    example === "" ||
    example.includes("\u0000") ||
    countScalars(example) > exampleLimits.maxExampleScalars
  ) {
    return invalidExample();
  }
  if (example.startsWith("https://") || example.startsWith("http://")) {
    const parsed = parseGithubUrl(example, examplePath);
    if (parsed === undefined) return invalidExample();
    return parsed;
  }
  if (example.includes("://") || example.includes("@")) return invalidExample();
  const parsed = parseOfficialShortName(example, examplePath);
  if (parsed === undefined) return invalidExample();
  return parsed;
}

async function fetchJson(
  fetchImpl: ExampleFetch,
  url: string,
): Promise<Readonly<Record<string, unknown>>> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    exampleLimits.fetchTimeoutMs,
  );
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      signal: controller.signal,
      redirect: "follow",
    });
    if (!response.ok) return unavailableExample();
    const payload: unknown = await response.json();
    if (typeof payload !== "object" || payload === null) {
      return unavailableExample();
    }
    return payload as Readonly<Record<string, unknown>>;
  } catch (error) {
    if (error instanceof CreatorError) throw error;
    return unavailableExample();
  } finally {
    clearTimeout(timer);
  }
}

async function headOk(fetchImpl: ExampleFetch, url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    exampleLimits.fetchTimeoutMs,
  );
  try {
    const response = await fetchImpl(url, {
      method: "HEAD",
      signal: controller.signal,
      redirect: "follow",
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Resolves branch metadata and verifies package.json without writing files. */
export async function resolveExampleReference(
  example: string,
  examplePath: string | undefined,
  fetchImpl: ExampleFetch = fetch,
): Promise<ExampleRepoInfo> {
  const parsed = parseExampleReference(example, examplePath);
  let branch = parsed.branch;
  if (branch === "") {
    const info = await fetchJson(
      fetchImpl,
      `https://api.github.com/repos/${parsed.owner}/${parsed.repository}`,
    );
    const defaultBranch = info.default_branch;
    if (typeof defaultBranch !== "string" || defaultBranch === "") {
      return unavailableExample();
    }
    branch = defaultBranch;
  }

  const packagePath =
    parsed.filePath === "" ? "package.json" : `${parsed.filePath}/package.json`;
  const packageUrl =
    `https://api.github.com/repos/${parsed.owner}/${parsed.repository}/contents/` +
    `${packagePath.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(branch)}`;
  const exists = await headOk(fetchImpl, packageUrl);
  if (!exists) return unavailableExample(["package.json"]);

  return Object.freeze({
    ...parsed,
    branch,
  });
}

function rewritePackageName(contents: string, projectName: string): string {
  let manifest: unknown;
  try {
    manifest = JSON.parse(contents) as unknown;
  } catch {
    return failedExample(["package.json"]);
  }
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    Array.isArray(manifest)
  ) {
    return failedExample(["package.json"]);
  }
  const next = {
    ...(manifest as Record<string, unknown>),
    name: projectName,
  };
  return `${JSON.stringify(next, undefined, 2)}\n`;
}

async function downloadToFile(
  fetchImpl: ExampleFetch,
  url: string,
  destination: string,
): Promise<void> {
  let requested: URL;
  try {
    requested = new URL(url);
  } catch {
    return unavailableExample();
  }
  if (requested.hostname !== "codeload.github.com") return unavailableExample();

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    exampleLimits.fetchTimeoutMs,
  );
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok || response.body === null) return unavailableExample();
    let total = 0;
    const limiter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > exampleLimits.maxArchiveBytes) {
          controller.error(new CreatorError("EXAMPLE_UNAVAILABLE"));
          return;
        }
        controller.enqueue(chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body.pipeThrough(limiter)),
      createWriteStream(destination),
    );
  } catch (error) {
    if (error instanceof CreatorError) throw error;
    return unavailableExample();
  } finally {
    clearTimeout(timer);
  }
}

async function listRegularFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) failedExample();
      files.push(absolute);
      if (files.length > exampleLimits.maxExtractedFiles) failedExample();
    }
  }
  await walk(root);
  return files.sort();
}

async function rollbackCreated(
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

async function ensureDirectory(
  path: string,
  fileSystem: ScaffoldFileSystem,
  createdDirectories: string[],
): Promise<void> {
  try {
    const status = await fileSystem.lstat(path);
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new CreatorError("TARGET_UNSAFE");
    }
    return;
  } catch (error) {
    if (error instanceof CreatorError) throw error;
    if (
      readErrorCode(error) !== "ENOENT" &&
      readErrorCode(error) !== "ENOTDIR"
    ) {
      throw new CreatorError("TARGET_UNSAFE");
    }
  }
  try {
    await fileSystem.mkdir(path);
    createdDirectories.push(path);
  } catch (error) {
    if (readErrorCode(error) !== "EEXIST") {
      throw new CreatorError("EXAMPLE_FAILED");
    }
    const status = await fileSystem.lstat(path);
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new CreatorError("TARGET_UNSAFE");
    }
  }
}

async function copyExtractedProject(options: {
  readonly stagingDirectory: string;
  readonly targetDirectory: string;
  readonly cwd: string;
  readonly normalizedTarget: string;
  readonly projectName: string;
  readonly fileSystem: ScaffoldFileSystem;
}): Promise<readonly string[]> {
  const {
    stagingDirectory,
    targetDirectory,
    cwd,
    normalizedTarget,
    projectName,
    fileSystem,
  } = options;
  const targetSegments =
    normalizedTarget === "." ? [] : normalizedTarget.split("/");
  const createdEntries: string[] = [];
  const createdDirectories: string[] = [];
  let activeRelative: string | undefined;

  try {
    let current = cwd;
    for (const segment of targetSegments) {
      current = join(current, segment);
      await ensureDirectory(current, fileSystem, createdDirectories);
    }

    const absoluteFiles = await listRegularFiles(stagingDirectory);
    const writtenRelative: string[] = [];
    for (const absolute of absoluteFiles) {
      const relativePath = relative(stagingDirectory, absolute)
        .split(sep)
        .join("/");
      activeRelative = relativePath;
      if (
        relativePath === "" ||
        relativePath
          .split("/")
          .some((segment) => segment === ".." || segment === "")
      ) {
        failedExample();
      }
      const status = await stat(absolute);
      if (status.size > exampleLimits.maxFileBytes) {
        failedExample([relativePath]);
      }

      let contents = await readFile(absolute);
      if (relativePath === "package.json") {
        contents = Buffer.from(
          rewritePackageName(contents.toString("utf8"), projectName),
          "utf8",
        );
      }

      const destination = join(targetDirectory, ...relativePath.split("/"));
      const parentRelative = dirname(relativePath);
      if (parentRelative !== ".") {
        let nested = targetDirectory;
        for (const segment of parentRelative.split("/")) {
          nested = join(nested, segment);
          await ensureDirectory(nested, fileSystem, createdDirectories);
        }
      }
      await writeFile(destination, contents, { flag: "wx" });
      createdEntries.push(destination);
      writtenRelative.push(relativePath);
    }
    return Object.freeze(writtenRelative.sort());
  } catch (error) {
    const rolledBack = await rollbackCreated(
      fileSystem,
      createdEntries,
      createdDirectories,
    );
    if (!rolledBack) {
      failedExample(activeRelative === undefined ? [] : [activeRelative]);
    }
    if (error instanceof CreatorError) throw error;
    if (readErrorCode(error) === "EEXIST") {
      throw new CreatorError(
        "SCAFFOLD_CONFLICT",
        activeRelative === undefined ? [] : [activeRelative],
      );
    }
    failedExample(activeRelative === undefined ? [] : [activeRelative]);
  }
}

async function extractRepository(
  archivePath: string,
  stagingDirectory: string,
  info: ExampleRepoInfo,
): Promise<void> {
  let rootPath: string | null = null;
  const prefix =
    info.filePath === ""
      ? []
      : info.filePath.split("/").filter((segment) => segment !== "");
  try {
    await extractTar({
      file: archivePath,
      cwd: stagingDirectory,
      strict: true,
      preservePaths: false,
      onentry(entry) {
        const posixPath = entry.path.split(sep).join(posix.sep);
        if (
          entry.type === "SymbolicLink" ||
          entry.type === "Link" ||
          posixPath.includes("\u0000") ||
          posixPath.split(posix.sep).some((segment) => segment === "..")
        ) {
          entry.resume();
          throw new CreatorError("EXAMPLE_FAILED");
        }
        if (rootPath === null) {
          rootPath = posixPath.split(posix.sep)[0] ?? null;
        }
      },
      filter(path) {
        const posixPath = path.split(sep).join(posix.sep);
        if (rootPath === null) {
          rootPath = posixPath.split(posix.sep)[0] ?? null;
        }
        if (rootPath === null) return false;
        if (prefix.length === 0) {
          return posixPath === rootPath || posixPath.startsWith(`${rootPath}/`);
        }
        const wanted = `${rootPath}/${prefix.join("/")}`;
        return posixPath === wanted || posixPath.startsWith(`${wanted}/`);
      },
      strip: prefix.length === 0 ? 1 : prefix.length + 1,
    });
  } catch (error) {
    if (error instanceof CreatorError) throw error;
    failedExample();
  }
}

export interface ExampleProject {
  readonly directory: string;
  readonly projectName: string;
  readonly label: string;
  readonly files: readonly string[];
}

/** Downloads, extracts, and writes one GitHub example into an empty target. */
export async function createExampleProject(
  options: CreateExampleProjectOptions,
): Promise<ExampleProject> {
  const fileSystem = options.fileSystem ?? defaultScaffoldFileSystem;
  const fetchImpl = options.fetch ?? fetch;
  const target = await assertCreatableStarterTarget(
    options.cwd,
    options.target,
    fileSystem,
  );
  const info = await resolveExampleReference(
    options.example,
    options.examplePath,
    fetchImpl,
  );

  const stagingRoot = await mkdtemp(join(tmpdir(), "invokta-example-"));
  const archivePath = join(stagingRoot, "repository.tar.gz");
  const extractDirectory = join(stagingRoot, "extract");
  await mkdir(extractDirectory);

  try {
    await downloadToFile(
      fetchImpl,
      `https://codeload.github.com/${info.owner}/${info.repository}/tar.gz/${info.branch}`,
      archivePath,
    );
    await extractRepository(archivePath, extractDirectory, info);

    try {
      await stat(join(extractDirectory, "package.json"));
    } catch {
      unavailableExample(["package.json"]);
    }

    const files = await copyExtractedProject({
      stagingDirectory: extractDirectory,
      targetDirectory: target.directory,
      cwd: options.cwd,
      normalizedTarget: target.normalizedTarget,
      projectName: target.projectName,
      fileSystem,
    });

    return Object.freeze({
      directory: target.directory,
      projectName: target.projectName,
      label: info.label,
      files,
    });
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}
