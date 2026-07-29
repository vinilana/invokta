import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Builds throwaway engine projects on the real filesystem. `package` writes
 * files, renames them, and reports mtimes, so its evidence needs a real
 * directory rather than an in-memory double.
 */
const createdRoots: string[] = [];

export interface ProjectOptions {
  /** A record is encoded as JSON; a string is written verbatim. */
  readonly manifest?: unknown;
  readonly omitManifest?: boolean;
  readonly packageJson?: unknown;
  readonly omitPackageJson?: boolean;
  /** Defaults to a single `package-lock.json`. */
  readonly lockfiles?: readonly string[];
  /** Writes the manifest entry as a regular file. Defaults to `true`. */
  readonly buildEntry?: boolean;
  /** Extra files, keyed by project-relative POSIX path. */
  readonly files?: Readonly<Record<string, string>>;
}

export const defaultManifest = Object.freeze({
  schemaVersion: 1,
  entry: "dist/mcp-http.js",
});

export const defaultPackageJson = Object.freeze({
  name: "support-engine",
  version: "1.4.2",
  scripts: { build: "tsc -b" },
});

function encode(value: unknown): string {
  return typeof value === "string"
    ? value
    : `${JSON.stringify(value, null, 2)}\n`;
}

export function writeProjectFile(
  root: string,
  relativePath: string,
  contents: string,
): string {
  const target = join(root, ...relativePath.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
  return target;
}

export function createProject(options: ProjectOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), "invokta-package-"));
  createdRoots.push(root);

  const manifest = options.manifest ?? defaultManifest;
  if (options.omitManifest !== true) {
    writeProjectFile(root, "invokta.deploy.json", encode(manifest));
  }
  if (options.omitPackageJson !== true) {
    writeProjectFile(
      root,
      "package.json",
      encode(options.packageJson ?? defaultPackageJson),
    );
  }
  for (const lockfile of options.lockfiles ?? ["package-lock.json"]) {
    writeProjectFile(root, lockfile, "{}\n");
  }
  if (options.buildEntry !== false) {
    const entry =
      typeof manifest === "object" &&
      manifest !== null &&
      typeof (manifest as { readonly entry?: unknown }).entry === "string"
        ? ((manifest as { readonly entry: string }).entry as string)
        : defaultManifest.entry;
    writeProjectFile(root, entry, "// built output\n");
  }
  for (const [path, contents] of Object.entries(options.files ?? {})) {
    writeProjectFile(root, path, contents);
  }
  return root;
}

export function removeCreatedProjects(): void {
  for (const root of createdRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
}
