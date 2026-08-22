import type { Dirent, Stats } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";

import { defineConnector, EngineError } from "@invokta/core";
import { parseDocument } from "yaml";
import { z } from "zod";

import type {
  JsonValue,
  OpenVaultNodeResult,
  VaultKnowledgeGraph,
  VaultNodeLink,
  VaultNodeSummary,
} from "../application/ports.js";

const defaultMaxFiles = 10_000;
const defaultMaxNoteBytes = 1_048_576;
const defaultMaxTotalBytes = 52_428_800;
const defaultMaxDirectoryEntries = 50_000;
const defaultMaxFrontmatterCharacters = 8_192;
const defaultMaxFrontmatterProperties = 64;
const defaultMaxFrontmatterDepth = 4;
const defaultMaxFrontmatterArrayLength = 100;
const maximumFrontmatterStringCharacters = 4_096;
const maximumIndexDeclarations = 100;
const maximumWikilinkReferenceCharacters = 300;
const nodeIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;
const defaultExposedFrontmatterKeys = Object.freeze([
  "id",
  "kind",
  "entrypoint",
  "title",
  "summary",
  "status",
  "project",
  "topics",
  "updated",
  "indexes",
]);

export interface FilesystemObsidianVaultOptions {
  readonly vaultPath: string;
  readonly exposedFrontmatterKeys?: ReadonlyArray<string>;
  readonly maxFiles?: number;
  readonly maxNoteBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxDirectoryEntries?: number;
  readonly maxFrontmatterCharacters?: number;
  readonly maxFrontmatterProperties?: number;
  readonly maxFrontmatterDepth?: number;
  readonly maxFrontmatterArrayLength?: number;
}

export type FilesystemObsidianConnectorDependencies = Readonly<
  Record<string, never>
>;

const positiveSafeInteger = z.number().int().positive().safe();
const filesystemObsidianConnectorConfig = z.object({
  vaultPath: z.string().refine((value) => value.trim() !== ""),
  exposedFrontmatterKeys: z
    .array(z.string().min(1).max(100))
    .max(defaultMaxFrontmatterProperties)
    .refine((keys) => new Set(keys).size === keys.length)
    .optional(),
  maxFiles: positiveSafeInteger.optional(),
  maxNoteBytes: positiveSafeInteger.optional(),
  maxTotalBytes: positiveSafeInteger.optional(),
  maxDirectoryEntries: positiveSafeInteger.optional(),
  maxFrontmatterCharacters: positiveSafeInteger.optional(),
  maxFrontmatterProperties: positiveSafeInteger.optional(),
  maxFrontmatterDepth: positiveSafeInteger.optional(),
  maxFrontmatterArrayLength: positiveSafeInteger.optional(),
});

interface ParsedNode extends VaultNodeSummary {
  readonly kind: string | null;
  readonly entrypoint: boolean;
  readonly indexes: ReadonlyArray<string>;
  readonly content: string;
  readonly wikilinks: ReadonlyArray<string>;
}

interface GraphSnapshot {
  readonly nodesById: ReadonlyMap<string, ParsedNode>;
  readonly roots: ReadonlyArray<ParsedNode>;
  readonly invalidNodeCount: number;
  readonly resolveWikilink: (reference: string) => ParsedNode | null;
}

type ParsedFile =
  | { readonly kind: "ignored" }
  | { readonly kind: "invalid" }
  | { readonly kind: "node"; readonly node: ParsedNode };

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function nonnegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a nonnegative safe integer.`);
  }
  return value;
}

function vaultFailure(
  message: string,
  publicDetails?: Readonly<Record<string, string | number>>,
  cause?: unknown,
): EngineError {
  return new EngineError({
    code: "EXECUTION_FAILED",
    message,
    ...(publicDetails === undefined ? {} : { publicDetails }),
    ...(cause === undefined ? {} : { cause }),
  });
}

function portableRelativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function throwIfCancelled(signal: AbortSignal): void {
  signal.throwIfAborted();
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function splitFrontmatter(
  contents: string,
): { readonly yaml: string; readonly content: string } | null {
  const normalized = contents.replace(/\r\n?/gu, "\n");
  if (!normalized.startsWith("---\n")) return null;
  const closing = normalized.indexOf("\n---", 4);
  if (closing === -1) throw new Error("Frontmatter is not terminated.");
  const afterClosing = closing + 4;
  if (afterClosing < normalized.length && normalized[afterClosing] !== "\n") {
    throw new Error("Frontmatter closing marker is malformed.");
  }
  return {
    yaml: normalized.slice(4, closing),
    content: normalized.slice(afterClosing + 1),
  };
}

interface FrontmatterLimits {
  readonly maxCharacters: number;
  readonly maxProperties: number;
  readonly maxDepth: number;
  readonly maxArrayLength: number;
}

function normalizeJsonValue(
  value: unknown,
  limits: FrontmatterLimits,
  depth = 0,
): JsonValue {
  if (depth > limits.maxDepth) {
    throw new Error("Frontmatter nesting is too deep.");
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > maximumFrontmatterStringCharacters) {
      throw new Error("A frontmatter string is too long.");
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new Error("Frontmatter contains an unsupported number.");
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > limits.maxArrayLength) {
      throw new Error("A frontmatter array is too long.");
    }
    return value.map((item) => normalizeJsonValue(item, limits, depth + 1));
  }
  if (!isRecord(value)) {
    throw new Error("Frontmatter contains an unsupported value.");
  }
  const entries = Object.entries(value);
  if (entries.length > limits.maxProperties) {
    throw new Error("A frontmatter object has too many properties.");
  }
  return Object.fromEntries(
    entries.map(([key, item]) => {
      if (key === "" || key.length > 100) {
        throw new Error("A frontmatter property name is invalid.");
      }
      return [key, normalizeJsonValue(item, limits, depth + 1)];
    }),
  );
}

function readNodeId(
  frontmatter: Readonly<Record<string, unknown>>,
): string | null {
  const id = frontmatter.id;
  if (id === undefined) return null;
  if (
    typeof id !== "string" ||
    id.length < 1 ||
    id.length > 200 ||
    !nodeIdPattern.test(id)
  ) {
    throw new Error("The node ID is invalid.");
  }
  return id;
}

function readIndexes(
  frontmatter: Readonly<Record<string, unknown>>,
): ReadonlyArray<string> {
  const indexes = frontmatter.indexes;
  if (indexes === undefined) return [];
  if (
    !Array.isArray(indexes) ||
    indexes.length > maximumIndexDeclarations ||
    !indexes.every(
      (item) =>
        typeof item === "string" &&
        item.length >= 1 &&
        item.length <= 200 &&
        nodeIdPattern.test(item),
    )
  ) {
    throw new Error("The node index declarations are invalid.");
  }
  return [...new Set(indexes)];
}

function readTitle(
  frontmatter: Readonly<Record<string, unknown>>,
  content: string,
  path: string,
): string {
  const configured = frontmatter.title;
  if (configured !== undefined) {
    if (
      typeof configured !== "string" ||
      configured.trim() === "" ||
      configured.length > 300
    ) {
      throw new Error("The node title is invalid.");
    }
    return configured.trim();
  }
  for (const line of content.split("\n")) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/u)?.[1]?.trim();
    if (heading !== undefined && heading !== "") return heading.slice(0, 300);
  }
  return basename(path, extname(path)).slice(0, 300) || "Untitled note";
}

function readWikilinks(content: string): ReadonlyArray<string> {
  const references: string[] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(/\[\[([^\]\n]+)\]\]/gu)) {
    const raw = match[1]?.split("|", 1)[0]?.split("#", 1)[0]?.trim();
    if (raw === undefined || raw === "" || seen.has(raw)) continue;
    seen.add(raw);
    references.push(raw.slice(0, maximumWikilinkReferenceCharacters));
  }
  return references;
}

function exposeFrontmatter(
  source: Readonly<Record<string, unknown>>,
  exposedKeys: ReadonlySet<string>,
  limits: FrontmatterLimits,
): Record<string, JsonValue> {
  if (Object.keys(source).length > limits.maxProperties) {
    throw new Error("Frontmatter has too many properties.");
  }
  const exposed = Object.fromEntries(
    Object.entries(source)
      .filter(([key]) => exposedKeys.has(key))
      .map(([key, value]) => [key, normalizeJsonValue(value, limits)]),
  );
  if (JSON.stringify(exposed).length > limits.maxCharacters) {
    throw new Error("Exposed frontmatter is too large.");
  }
  return exposed;
}

function parseNode(
  contents: string,
  path: string,
  exposedKeys: ReadonlySet<string>,
  limits: FrontmatterLimits,
): ParsedFile {
  let parts: ReturnType<typeof splitFrontmatter>;
  try {
    parts = splitFrontmatter(contents);
  } catch {
    return { kind: "invalid" };
  }
  if (parts === null) return { kind: "ignored" };

  let frontmatter: unknown;
  try {
    const document = parseDocument(parts.yaml, { uniqueKeys: true });
    if (document.errors.length > 0) return { kind: "invalid" };
    frontmatter = document.toJS({ maxAliasCount: 0 });
  } catch {
    return { kind: "invalid" };
  }
  if (!isRecord(frontmatter)) return { kind: "invalid" };

  let id: string | null;
  try {
    id = readNodeId(frontmatter);
  } catch {
    return { kind: "invalid" };
  }
  if (id === null) return { kind: "ignored" };

  try {
    const rawKind = frontmatter.kind;
    const nodeKind =
      rawKind === undefined
        ? null
        : typeof rawKind === "string" && rawKind.length <= 100
          ? rawKind
          : (() => {
              throw new Error("The node kind is invalid.");
            })();
    const rawEntrypoint = frontmatter.entrypoint;
    const entrypoint = rawEntrypoint === true;
    if (rawEntrypoint !== undefined && typeof rawEntrypoint !== "boolean") {
      throw new Error("The entrypoint flag is invalid.");
    }
    if (entrypoint && nodeKind !== "index") {
      throw new Error("Only indexes can be entrypoints.");
    }
    return {
      kind: "node",
      node: {
        id,
        kind: nodeKind,
        entrypoint,
        indexes: readIndexes(frontmatter),
        title: readTitle(frontmatter, parts.content, path),
        path,
        frontmatter: exposeFrontmatter(frontmatter, exposedKeys, limits),
        content: parts.content,
        wikilinks: readWikilinks(parts.content),
      },
    };
  } catch {
    return { kind: "invalid" };
  }
}

function normalizeLookupKey(value: string): string {
  return value.replace(/\\/gu, "/").replace(/\.md$/iu, "").toLowerCase();
}

function createResolver(nodes: ReadonlyArray<ParsedNode>) {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const lookup = new Map<string, ParsedNode | null>();
  const add = (key: string, node: ParsedNode): void => {
    const normalized = normalizeLookupKey(key);
    const previous = lookup.get(normalized);
    lookup.set(
      normalized,
      previous === undefined || previous === node ? node : null,
    );
  };
  for (const node of nodes) {
    add(node.path, node);
    add(node.path.slice(0, -extname(node.path).length), node);
    add(basename(node.path, extname(node.path)), node);
    add(node.title, node);
  }
  return (reference: string): ParsedNode | null =>
    nodesById.get(reference) ??
    lookup.get(normalizeLookupKey(reference)) ??
    null;
}

function summary(node: ParsedNode): VaultNodeSummary {
  return {
    id: node.id,
    title: node.title,
    path: node.path,
    frontmatter: structuredClone(node.frontmatter),
  };
}

function notFound(invalidNodeCount: number): OpenVaultNodeResult {
  return {
    found: false,
    node: null,
    relatedIndexes: [],
    outgoingLinks: [],
    unresolvedLinks: [],
    unresolvedIndexes: [],
    invalidNodeCount,
    relationsTruncated: false,
  };
}

export function createFilesystemObsidianVault(
  options: FilesystemObsidianVaultOptions,
): VaultKnowledgeGraph {
  if (options.vaultPath.trim() === "") {
    throw new TypeError("vaultPath must not be empty.");
  }
  const vaultPath = resolve(options.vaultPath);
  const maxFiles = positiveInteger(
    options.maxFiles ?? defaultMaxFiles,
    "maxFiles",
  );
  const maxNoteBytes = positiveInteger(
    options.maxNoteBytes ?? defaultMaxNoteBytes,
    "maxNoteBytes",
  );
  const maxTotalBytes = positiveInteger(
    options.maxTotalBytes ?? defaultMaxTotalBytes,
    "maxTotalBytes",
  );
  const maxDirectoryEntries = positiveInteger(
    options.maxDirectoryEntries ?? defaultMaxDirectoryEntries,
    "maxDirectoryEntries",
  );
  const frontmatterLimits: FrontmatterLimits = {
    maxCharacters: positiveInteger(
      options.maxFrontmatterCharacters ?? defaultMaxFrontmatterCharacters,
      "maxFrontmatterCharacters",
    ),
    maxProperties: positiveInteger(
      options.maxFrontmatterProperties ?? defaultMaxFrontmatterProperties,
      "maxFrontmatterProperties",
    ),
    maxDepth: positiveInteger(
      options.maxFrontmatterDepth ?? defaultMaxFrontmatterDepth,
      "maxFrontmatterDepth",
    ),
    maxArrayLength: positiveInteger(
      options.maxFrontmatterArrayLength ?? defaultMaxFrontmatterArrayLength,
      "maxFrontmatterArrayLength",
    ),
  };
  const configuredKeys =
    options.exposedFrontmatterKeys ?? defaultExposedFrontmatterKeys;
  if (
    configuredKeys.length > defaultMaxFrontmatterProperties ||
    configuredKeys.some((key) => key === "" || key.length > 100) ||
    new Set(configuredKeys).size !== configuredKeys.length
  ) {
    throw new TypeError(
      "exposedFrontmatterKeys must contain unique valid keys.",
    );
  }
  const exposedKeys = new Set(configuredKeys);

  const readSnapshot = async (signal: AbortSignal): Promise<GraphSnapshot> => {
    throwIfCancelled(signal);
    let rootStat: Stats;
    try {
      rootStat = await stat(vaultPath);
    } catch (cause) {
      if (signal.aborted) throw signal.reason;
      throw vaultFailure(
        "The Obsidian vault could not be read.",
        undefined,
        cause,
      );
    }
    if (!rootStat.isDirectory()) {
      throw vaultFailure("The configured Obsidian vault is not a directory.");
    }

    const paths: string[] = [];
    let directoryEntries = 0;
    const visit = async (directory: string): Promise<void> => {
      throwIfCancelled(signal);
      let entries: Dirent[];
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (cause) {
        if (signal.aborted) throw signal.reason;
        throw vaultFailure(
          "The Obsidian vault could not be scanned.",
          undefined,
          cause,
        );
      }
      entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
      for (const entry of entries) {
        throwIfCancelled(signal);
        directoryEntries += 1;
        if (directoryEntries > maxDirectoryEntries) {
          throw vaultFailure("The Obsidian vault entry limit was exceeded.", {
            limit: maxDirectoryEntries,
          });
        }
        if (entry.isSymbolicLink() || entry.name === ".obsidian") continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(path);
        } else if (
          entry.isFile() &&
          entry.name.toLocaleLowerCase("en-US").endsWith(".md")
        ) {
          paths.push(path);
          if (paths.length > maxFiles) {
            throw vaultFailure("The Obsidian vault file limit was exceeded.", {
              limit: maxFiles,
            });
          }
        }
      }
    };
    await visit(vaultPath);
    paths.sort((left, right) =>
      portableRelativePath(vaultPath, left).localeCompare(
        portableRelativePath(vaultPath, right),
        "en",
      ),
    );

    const nodes: ParsedNode[] = [];
    const nodesById = new Map<string, ParsedNode>();
    let invalidNodeCount = 0;
    let totalBytes = 0;
    for (const absolutePath of paths) {
      throwIfCancelled(signal);
      let fileStat: Stats;
      try {
        fileStat = await stat(absolutePath);
      } catch (cause) {
        if (signal.aborted) throw signal.reason;
        throw vaultFailure(
          "An Obsidian note could not be inspected.",
          undefined,
          cause,
        );
      }
      if (!fileStat.isFile()) continue;
      if (fileStat.size > maxNoteBytes) {
        invalidNodeCount += 1;
        continue;
      }
      totalBytes += fileStat.size;
      if (totalBytes > maxTotalBytes) {
        throw vaultFailure("The Obsidian vault byte limit was exceeded.", {
          limit: maxTotalBytes,
        });
      }

      let contents: string;
      try {
        const bytes = await readFile(absolutePath, { signal });
        contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch (cause) {
        if (signal.aborted) throw signal.reason;
        throw vaultFailure(
          "An Obsidian note could not be read as UTF-8 Markdown.",
          undefined,
          cause,
        );
      }
      const path = portableRelativePath(vaultPath, absolutePath);
      const parsed = parseNode(contents, path, exposedKeys, frontmatterLimits);
      if (parsed.kind === "invalid") {
        invalidNodeCount += 1;
        continue;
      }
      if (parsed.kind === "ignored") continue;
      if (nodesById.has(parsed.node.id)) {
        throw vaultFailure("The Obsidian vault contains duplicate node IDs.", {
          id: parsed.node.id,
        });
      }
      nodes.push(parsed.node);
      nodesById.set(parsed.node.id, parsed.node);
    }
    const roots = nodes
      .filter((node) => node.kind === "index" && node.entrypoint)
      .sort((left, right) => left.path.localeCompare(right.path, "en"));
    return {
      nodesById,
      roots,
      invalidNodeCount,
      resolveWikilink: createResolver(nodes),
    };
  };

  return {
    async listRoots(request, { signal }) {
      const maxRoots = positiveInteger(request.maxRoots, "maxRoots");
      const snapshot = await readSnapshot(signal);
      return {
        roots: snapshot.roots.slice(0, maxRoots).map(summary),
        invalidNodeCount: snapshot.invalidNodeCount,
        truncated: snapshot.roots.length > maxRoots,
      };
    },

    async openNode(request, { signal }) {
      nonnegativeInteger(request.contentOffset, "contentOffset");
      positiveInteger(request.maxContentCharacters, "maxContentCharacters");
      positiveInteger(request.maxRelatedIndexes, "maxRelatedIndexes");
      positiveInteger(request.maxOutgoingLinks, "maxOutgoingLinks");
      const snapshot = await readSnapshot(signal);
      const selected = snapshot.nodesById.get(request.id);
      if (selected === undefined) return notFound(snapshot.invalidNodeCount);

      let relationsTruncated = false;
      const relatedIndexes: VaultNodeSummary[] = [];
      const unresolvedIndexes: string[] = [];
      for (const indexId of selected.indexes) {
        if (
          relatedIndexes.length + unresolvedIndexes.length >=
          request.maxRelatedIndexes
        ) {
          relationsTruncated = true;
          break;
        }
        const index = snapshot.nodesById.get(indexId);
        if (index?.kind === "index") relatedIndexes.push(summary(index));
        else unresolvedIndexes.push(indexId);
      }

      const outgoingLinks: VaultNodeLink[] = [];
      const unresolvedLinks: string[] = [];
      for (const reference of selected.wikilinks) {
        if (
          outgoingLinks.length + unresolvedLinks.length >=
          request.maxOutgoingLinks
        ) {
          relationsTruncated = true;
          break;
        }
        const target = snapshot.resolveWikilink(reference);
        if (target === null) {
          unresolvedLinks.push(reference);
        } else {
          outgoingLinks.push({
            reference,
            id: target.id,
            title: target.title,
            path: target.path,
          });
        }
      }

      const content = selected.content.slice(
        request.contentOffset,
        request.contentOffset + request.maxContentCharacters,
      );
      return {
        found: true,
        node: {
          ...summary(selected),
          content,
          contentOffset: request.contentOffset,
          contentLength: selected.content.length,
          contentTruncated:
            request.contentOffset + content.length < selected.content.length,
        },
        relatedIndexes,
        outgoingLinks,
        unresolvedLinks,
        unresolvedIndexes,
        invalidNodeCount: snapshot.invalidNodeCount,
        relationsTruncated,
      };
    },
  };
}

export const filesystemObsidianConnector = defineConnector({
  name: "filesystem-obsidian",
  config: filesystemObsidianConnectorConfig,
  create(config, _dependencies: FilesystemObsidianConnectorDependencies) {
    const options: FilesystemObsidianVaultOptions = {
      vaultPath: config.vaultPath,
      ...(config.exposedFrontmatterKeys === undefined
        ? {}
        : { exposedFrontmatterKeys: config.exposedFrontmatterKeys }),
      ...(config.maxFiles === undefined ? {} : { maxFiles: config.maxFiles }),
      ...(config.maxNoteBytes === undefined
        ? {}
        : { maxNoteBytes: config.maxNoteBytes }),
      ...(config.maxTotalBytes === undefined
        ? {}
        : { maxTotalBytes: config.maxTotalBytes }),
      ...(config.maxDirectoryEntries === undefined
        ? {}
        : { maxDirectoryEntries: config.maxDirectoryEntries }),
      ...(config.maxFrontmatterCharacters === undefined
        ? {}
        : { maxFrontmatterCharacters: config.maxFrontmatterCharacters }),
      ...(config.maxFrontmatterProperties === undefined
        ? {}
        : { maxFrontmatterProperties: config.maxFrontmatterProperties }),
      ...(config.maxFrontmatterDepth === undefined
        ? {}
        : { maxFrontmatterDepth: config.maxFrontmatterDepth }),
      ...(config.maxFrontmatterArrayLength === undefined
        ? {}
        : { maxFrontmatterArrayLength: config.maxFrontmatterArrayLength }),
    };
    return { ports: { graph: createFilesystemObsidianVault(options) } };
  },
});
