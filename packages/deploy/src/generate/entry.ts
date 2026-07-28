import { join } from "node:path";

const separator = /[\\/]/u;

/**
 * The manifest accepts either separator; container paths and generated text
 * always use `/`. Validation has already rejected absolute paths, empty
 * segments, and `..`, so splitting is safe here.
 */
export function entrySegments(entry: string): readonly string[] {
  return entry.split(separator);
}

export function entryPosixPath(entry: string): string {
  return entrySegments(entry).join("/");
}

/**
 * The smallest thing the runtime stage has to copy: the top directory the
 * build emits, or the entry file itself when the build writes to the root.
 */
export function entryOutputPath(entry: string): string {
  return entrySegments(entry)[0] as string;
}

export function entryFileSystemPath(cwd: string, entry: string): string {
  return join(cwd, ...entrySegments(entry));
}
