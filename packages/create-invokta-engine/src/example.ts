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
} from "./scaffold.js";

export const exampleLimits = Object.freeze({
  maxExampleScalars: 2_048,
  maxShortNameCharacters: 214,
  maxShortNameSegments: 8,
  maxExamplePathScalars: 1_024,
  maxExamplePathSegments: 32,
  fetchTimeoutMs: 60_000,
  /** Uncompressed retained bytes across extracted regular files. */
  maxArchiveBytes: 52_428_800,
  /** Compressed download bytes from codeload.github.com. */
  maxCompressedArchiveBytes: 52_428_800,
  maxExtractedFiles: 10_000,
  maxFileBytes: 5_242_880,
});

export type ExampleRuntimeLimits = Readonly<{
  maxArchiveBytes: number;
  maxCompressedArchiveBytes: number;
  maxExtractedFiles: number;
  maxFileBytes: number;
  fetchTimeoutMs: number;
}>;

export const officialExampleSource = Object.freeze({
  owner: "vinilana",
  repository: "invokta",
  branch: "main",
  directory: "examples",
});

const shortNamePattern =
  /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/u;
const githubOwnerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const githubRepositoryPattern = /^[A-Za-z0-9._-]{1,100}$/u;
const githubBranchPattern = /^[^\0\n\r]+$/u;

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
  /** Already-resolved example metadata; callers resolve exactly once. */
  readonly example: ExampleRepoInfo;
  readonly fetch?: ExampleFetch;
  /** Optional limit overrides for focused tests. */
  readonly limits?: Partial<ExampleRuntimeLimits>;
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

function decodeGithubSegment(segment: string): string | undefined {
  let decoded = segment;
  if (segment.includes("%")) {
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return undefined;
    }
  }
  if (
    decoded === "" ||
    decoded.includes("/") ||
    decoded.includes("\\") ||
    decoded.includes("\u0000") ||
    decoded.includes("%")
  ) {
    return undefined;
  }
  return decoded;
}

function isValidGithubOwner(owner: string): boolean {
  return githubOwnerPattern.test(owner);
}

function isValidGithubRepository(repository: string): boolean {
  return githubRepositoryPattern.test(repository);
}

function isValidGithubBranch(branch: string): boolean {
  return (
    branch !== "" &&
    !branch.includes("\u0000") &&
    githubBranchPattern.test(branch) &&
    !branch.split("/").some((segment) => segment === "" || segment === "..")
  );
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
  const [rawOwner, rawRepository, treeToken, ...rest] = segments;
  if (rawOwner === undefined || rawRepository === undefined) return undefined;
  const owner = decodeGithubSegment(rawOwner);
  const repository = decodeGithubSegment(stripGitSuffix(rawRepository));
  if (
    owner === undefined ||
    repository === undefined ||
    !isValidGithubOwner(owner) ||
    !isValidGithubRepository(repository)
  ) {
    return undefined;
  }
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
  const [rawBranch, ...pathSegments] = rest;
  if (rawBranch === undefined) return undefined;
  const branch = decodeGithubSegment(rawBranch);
  if (branch === undefined || !isValidGithubBranch(branch)) return undefined;
  const urlPath = pathSegments
    .map((segment) => decodeGithubSegment(segment))
    .every((segment) => segment !== undefined)
    ? pathSegments
        .map((segment) => decodeGithubSegment(segment) as string)
        .join("/")
    : undefined;
  if (urlPath === undefined && pathSegments.length > 0) return undefined;
  const filePath =
    overridePath ??
    (urlPath === undefined || urlPath === ""
      ? ""
      : normalizeExamplePath(urlPath));
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

function resolveRuntimeLimits(
  overrides: Partial<ExampleRuntimeLimits> | undefined,
): ExampleRuntimeLimits {
  return Object.freeze({
    maxArchiveBytes:
      overrides?.maxArchiveBytes ?? exampleLimits.maxArchiveBytes,
    maxCompressedArchiveBytes:
      overrides?.maxCompressedArchiveBytes ??
      exampleLimits.maxCompressedArchiveBytes,
    maxExtractedFiles:
      overrides?.maxExtractedFiles ?? exampleLimits.maxExtractedFiles,
    maxFileBytes: overrides?.maxFileBytes ?? exampleLimits.maxFileBytes,
    fetchTimeoutMs: overrides?.fetchTimeoutMs ?? exampleLimits.fetchTimeoutMs,
  });
}

async function fetchJson(
  fetchImpl: ExampleFetch,
  url: string,
  timeoutMs: number,
): Promise<Readonly<Record<string, unknown>>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      signal: controller.signal,
      redirect: "error",
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

async function headOk(
  fetchImpl: ExampleFetch,
  url: string,
  timeoutMs: number,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "HEAD",
      signal: controller.signal,
      redirect: "error",
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
  limits?: Partial<ExampleRuntimeLimits>,
): Promise<ExampleRepoInfo> {
  const runtime = resolveRuntimeLimits(limits);
  const parsed = parseExampleReference(example, examplePath);
  let branch = parsed.branch;
  if (branch === "") {
    const info = await fetchJson(
      fetchImpl,
      `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repository)}`,
      runtime.fetchTimeoutMs,
    );
    const defaultBranch = info.default_branch;
    if (typeof defaultBranch !== "string" || defaultBranch === "") {
      return unavailableExample();
    }
    if (!isValidGithubBranch(defaultBranch)) return unavailableExample();
    branch = defaultBranch;
  }

  const packagePath =
    parsed.filePath === "" ? "package.json" : `${parsed.filePath}/package.json`;
  const packageUrl =
    `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repository)}/contents/` +
    `${packagePath.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(branch)}`;
  const exists = await headOk(fetchImpl, packageUrl, runtime.fetchTimeoutMs);
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
  limits: ExampleRuntimeLimits,
): Promise<void> {
  let requested: URL;
  try {
    requested = new URL(url);
  } catch {
    return unavailableExample();
  }
  if (requested.hostname !== "codeload.github.com") return unavailableExample();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.fetchTimeoutMs);
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
        if (total > limits.maxCompressedArchiveBytes) {
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
    }
  }
  await walk(root);
  return files.sort();
}

async function rollbackCreated(
  createdEntries: readonly string[],
  createdDirectories: readonly string[],
): Promise<boolean> {
  const fileSystem = defaultScaffoldFileSystem;
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
  createdDirectories: string[],
): Promise<void> {
  const fileSystem = defaultScaffoldFileSystem;
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
}): Promise<readonly string[]> {
  const {
    stagingDirectory,
    targetDirectory,
    cwd,
    normalizedTarget,
    projectName,
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
      await ensureDirectory(current, createdDirectories);
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
          await ensureDirectory(nested, createdDirectories);
        }
      }
      await writeFile(destination, contents, { flag: "wx" });
      createdEntries.push(destination);
      writtenRelative.push(relativePath);
    }
    return Object.freeze(writtenRelative.sort());
  } catch (error) {
    const rolledBack = await rollbackCreated(
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

function readEntryType(entry: unknown): string | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const type = (entry as { readonly type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}

function readEntrySize(entry: unknown): number {
  if (typeof entry !== "object" || entry === null) return 0;
  const size = (entry as { readonly size?: unknown }).size;
  return typeof size === "number" && Number.isFinite(size) ? size : 0;
}

function entryIsRegularFile(entry: unknown): boolean {
  const type = readEntryType(entry);
  return type === "File" || type === "0" || type === "" || type === undefined;
}

async function extractRepository(
  archivePath: string,
  stagingDirectory: string,
  info: ExampleRepoInfo,
  limits: ExampleRuntimeLimits,
): Promise<void> {
  let rootPath: string | null = null;
  let rejected = false;
  let uncompressedBytes = 0;
  let fileCount = 0;
  const prefix =
    info.filePath === ""
      ? []
      : info.filePath.split("/").filter((segment) => segment !== "");

  const markRejected = (): void => {
    rejected = true;
  };

  try {
    await extractTar({
      file: archivePath,
      cwd: stagingDirectory,
      strict: true,
      preservePaths: false,
      onentry(entry) {
        if (rejected) {
          entry.resume();
          return;
        }
        const posixPath = entry.path.split(sep).join(posix.sep);
        if (
          entry.type === "SymbolicLink" ||
          entry.type === "Link" ||
          posixPath.includes("\u0000") ||
          posixPath.split(posix.sep).some((segment) => segment === "..")
        ) {
          markRejected();
          entry.resume();
          return;
        }
        if (rootPath === null) {
          rootPath = posixPath.split(posix.sep)[0] ?? null;
        }
      },
      filter(path, entry) {
        if (rejected) return false;
        const posixPath = path.split(sep).join(posix.sep);
        if (
          posixPath.includes("\u0000") ||
          posixPath.split(posix.sep).some((segment) => segment === "..")
        ) {
          markRejected();
          return false;
        }
        const entryType = readEntryType(entry);
        if (entryType === "SymbolicLink" || entryType === "Link") {
          markRejected();
          return false;
        }
        if (rootPath === null) {
          rootPath = posixPath.split(posix.sep)[0] ?? null;
        }
        if (rootPath === null) return false;

        const inSubtree =
          prefix.length === 0
            ? posixPath === rootPath || posixPath.startsWith(`${rootPath}/`)
            : (() => {
                const wanted = `${rootPath}/${prefix.join("/")}`;
                return (
                  posixPath === wanted || posixPath.startsWith(`${wanted}/`)
                );
              })();
        if (!inSubtree) return false;

        if (entryIsRegularFile(entry)) {
          const size = readEntrySize(entry);
          if (size > limits.maxFileBytes) {
            markRejected();
            return false;
          }
          uncompressedBytes += size;
          if (uncompressedBytes > limits.maxArchiveBytes) {
            markRejected();
            return false;
          }
          fileCount += 1;
          if (fileCount > limits.maxExtractedFiles) {
            markRejected();
            return false;
          }
        }
        return true;
      },
      strip: prefix.length === 0 ? 1 : prefix.length + 1,
    });
  } catch (error) {
    if (error instanceof CreatorError) throw error;
    failedExample();
  }

  if (rejected) failedExample();
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
  const fetchImpl = options.fetch ?? fetch;
  const limits = resolveRuntimeLimits(options.limits);
  const target = await assertCreatableStarterTarget(
    options.cwd,
    options.target,
    defaultScaffoldFileSystem,
  );
  const info = options.example;
  if (!isValidGithubBranch(info.branch)) return unavailableExample();

  const stagingRoot = await mkdtemp(join(tmpdir(), "invokta-example-"));
  const archivePath = join(stagingRoot, "repository.tar.gz");
  const extractDirectory = join(stagingRoot, "extract");
  await mkdir(extractDirectory);

  try {
    const branchPath = info.branch
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    await downloadToFile(
      fetchImpl,
      `https://codeload.github.com/${encodeURIComponent(info.owner)}/${encodeURIComponent(info.repository)}/tar.gz/${branchPath}`,
      archivePath,
      limits,
    );
    await extractRepository(archivePath, extractDirectory, info, limits);

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
