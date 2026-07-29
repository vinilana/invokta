import type { Dirent, Stats } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";

import { EngineError } from "@ai-engine/core";

import type {
  VaultContextProvider,
  VaultContextResult,
} from "../application/ports.js";

const defaultMaxFiles = 10_000;
const defaultMaxNoteBytes = 1_048_576;
const defaultMaxTotalBytes = 52_428_800;
const defaultMaxDirectoryEntries = 50_000;
const maxExcerptCharacters = 1_200;
const maximumCountedOccurrences = 20;

export interface FilesystemObsidianVaultOptions {
  readonly vaultPath: string;
  readonly maxFiles?: number;
  readonly maxNoteBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxDirectoryEntries?: number;
}

interface RankedNote {
  readonly path: string;
  readonly title: string;
  readonly excerpt: string;
  readonly score: number;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer.`);
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

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Mark}+/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/\s+/gu, " ")
    .trim();
}

function searchTerms(query: string): ReadonlyArray<string> {
  return [
    ...new Set(normalizeSearchText(query).match(/[\p{Letter}\p{Number}]+/gu)),
  ];
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (count < maximumCountedOccurrences) {
    const index = text.indexOf(needle, offset);
    if (index === -1) return count;
    count += 1;
    offset = index + needle.length;
  }
  return count;
}

function scoreText(
  title: string,
  contents: string,
  phrase: string,
  terms: ReadonlyArray<string>,
): number {
  const normalizedTitle = normalizeSearchText(title);
  const normalizedContents = normalizeSearchText(contents);
  let score =
    countOccurrences(normalizedTitle, phrase) * 40 +
    countOccurrences(normalizedContents, phrase) * 12;
  for (const term of terms) {
    score += countOccurrences(normalizedTitle, term) * 12;
    score += countOccurrences(normalizedContents, term) * 2;
  }
  return score;
}

function withoutFrontmatter(contents: string): string {
  const normalized = contents.replace(/\r\n?/gu, "\n");
  if (!normalized.startsWith("---\n")) return normalized;
  const closing = normalized.indexOf("\n---\n", 4);
  return closing === -1 ? normalized : normalized.slice(closing + 5);
}

function noteTitle(contents: string, path: string): string {
  for (const line of withoutFrontmatter(contents).split("\n")) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/u)?.[1]?.trim();
    if (heading !== undefined && heading !== "") {
      return heading.slice(0, 300);
    }
  }
  return basename(path, extname(path)).slice(0, 300) || "Untitled note";
}

function noteExcerpt(
  contents: string,
  phrase: string,
  terms: ReadonlyArray<string>,
): string {
  const paragraphs = withoutFrontmatter(contents)
    .split(/\n\s*\n/gu)
    .map((paragraph) => paragraph.replace(/^#{1,6}\s+/u, "").trim())
    .filter((paragraph) => paragraph !== "");
  const ranked = paragraphs
    .map((paragraph, index) => ({
      paragraph,
      index,
      score: scoreText("", paragraph, phrase, terms),
    }))
    .sort(
      (left, right) => right.score - left.score || left.index - right.index,
    );
  const selected = ranked[0]?.paragraph ?? "";
  return selected.replace(/\s+/gu, " ").slice(0, maxExcerptCharacters);
}

function portableRelativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function throwIfCancelled(signal: AbortSignal): void {
  signal.throwIfAborted();
}

export function createFilesystemObsidianVault(
  options: FilesystemObsidianVaultOptions,
): VaultContextProvider {
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

  return {
    async provide(request, { signal }): Promise<VaultContextResult> {
      throwIfCancelled(signal);
      positiveInteger(request.maxNotes, "maxNotes");
      positiveInteger(request.maxContextCharacters, "maxContextCharacters");

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
      throwIfCancelled(signal);
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
        entries.sort((left, right) =>
          left.name.localeCompare(right.name, "en"),
        );
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
              throw vaultFailure(
                "The Obsidian vault file limit was exceeded.",
                {
                  limit: maxFiles,
                },
              );
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

      const phrase = normalizeSearchText(request.query);
      const terms = searchTerms(request.query);
      const rankedNotes: RankedNote[] = [];
      let totalBytes = 0;
      let truncated = false;
      for (const path of paths) {
        throwIfCancelled(signal);
        let fileStat: Stats;
        try {
          fileStat = await stat(path);
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
          truncated = true;
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
          const bytes = await readFile(path, { signal });
          contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch (cause) {
          if (signal.aborted) throw signal.reason;
          throw vaultFailure(
            "An Obsidian note could not be read as UTF-8 Markdown.",
            undefined,
            cause,
          );
        }
        const title = noteTitle(contents, path);
        const score = scoreText(title, contents, phrase, terms);
        if (score === 0) continue;
        rankedNotes.push({
          path: portableRelativePath(vaultPath, path),
          title,
          excerpt: noteExcerpt(contents, phrase, terms),
          score,
        });
      }

      rankedNotes.sort(
        (left, right) =>
          right.score - left.score || left.path.localeCompare(right.path, "en"),
      );
      const selected = rankedNotes.slice(0, request.maxNotes);
      truncated ||= rankedNotes.length > selected.length;

      let context = "";
      const sources: Array<{ path: string; title: string }> = [];
      for (const note of selected) {
        const section = `## ${note.title}\nSource: ${note.path}\n\n${note.excerpt}`;
        const segment = context === "" ? section : `\n\n${section}`;
        const available = request.maxContextCharacters - context.length;
        if (available <= 0) {
          truncated = true;
          break;
        }
        context += segment.slice(0, available);
        sources.push({ path: note.path, title: note.title });
        if (segment.length > available) {
          truncated = true;
          break;
        }
      }

      return { context, sources, truncated };
    },
  };
}
