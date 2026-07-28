import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { DeployError } from "../errors.js";
import { hasGeneratedFileMarker } from "./marker.js";
import type { GeneratedFile } from "./plan.js";

export type GeneratedFileStatus =
  | "conflict"
  | "created"
  | "unchanged"
  | "updated";

/** Private while it is written, readable once it is in place. */
const temporaryMode = 0o600;
const generatedMode = 0o644;

function isMissing(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { readonly code?: unknown }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

type ExistingFile =
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "text"; readonly contents: string };

async function readExisting(target: string): Promise<ExistingFile> {
  try {
    return { contents: await readFile(target, "utf8"), kind: "text" };
  } catch (error) {
    if (isMissing(error)) return { kind: "absent" };
    // Anything that cannot be read cannot be proven to be toolkit-managed, so
    // it is treated as a conflict rather than overwritten.
    return { kind: "unreadable" };
  }
}

async function writeAtomically(
  target: string,
  contents: string,
  relativePath: string,
): Promise<void> {
  const directory = dirname(target);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(temporary, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: temporaryMode,
    });
    // The image copies these files; the runtime user must be able to read them.
    await chmod(temporary, generatedMode);
    await rename(temporary, target);
  } catch {
    await unlink(temporary).catch(() => undefined);
    throw new DeployError("WRITE_FAILED", { details: [relativePath] });
  }
}

/**
 * Applies one generated file under the marker policy. A byte-identical target
 * is left untouched, an unmarked target is refused, and a changed target is
 * replaced through a temporary file so a reader never observes half a file.
 */
export async function applyGeneratedFile(
  root: string,
  file: GeneratedFile,
): Promise<GeneratedFileStatus> {
  const target = join(root, ...file.path.split("/"));
  const existing = await readExisting(target);

  if (existing.kind === "absent") {
    await writeAtomically(target, file.contents, file.path);
    return "created";
  }
  if (existing.kind === "unreadable") return "conflict";
  if (existing.contents === file.contents) return "unchanged";
  if (!hasGeneratedFileMarker(existing.contents, file.commentStyle)) {
    return "conflict";
  }
  await writeAtomically(target, file.contents, file.path);
  return "updated";
}
