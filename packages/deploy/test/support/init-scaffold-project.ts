import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const compilerPath = join(repositoryRoot, "node_modules/typescript/bin/tsc");

export interface ScaffoldProject {
  readonly directory: string;
  readonly sourceDirectory: string;
  readonly outputDirectory: string;
}

export interface CompileResult {
  readonly status: number | null;
  readonly output: string;
}

export interface RunResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Writes one throwaway engine project whose module resolution and compiler
 * options are the repository's own, so scaffolded sources are type-checked and
 * executed against the real workspace packages rather than against a stub.
 */
export function createScaffoldProject(
  sources: Readonly<Record<string, string>>,
): ScaffoldProject {
  const directory = mkdtempSync(join(tmpdir(), "ai-engine-scaffold-"));
  symlinkSync(
    join(repositoryRoot, "node_modules"),
    join(directory, "node_modules"),
    "dir",
  );
  writeProjectFile(directory, "package.json", {
    name: "scaffold-fixture",
    private: true,
    type: "module",
  });
  writeProjectFile(directory, "tsconfig.json", {
    extends: join(repositoryRoot, "tsconfig.base.json"),
    compilerOptions: { rootDir: "src", outDir: "dist" },
    include: ["src/**/*.ts"],
  });
  // The repository's own formatter and lint preset, so generated sources are
  // held to the standard an engine project is likely to apply to them.
  writeProjectFile(directory, "biome.json", {
    formatter: { enabled: true, indentStyle: "space" },
    linter: { enabled: true, rules: { preset: "recommended" } },
    assist: { actions: { source: { organizeImports: "on" } } },
  });
  for (const [relativePath, contents] of Object.entries(sources)) {
    const file = join(directory, relativePath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents, "utf8");
  }
  return {
    directory,
    sourceDirectory: join(directory, "src"),
    outputDirectory: join(directory, "dist"),
  };
}

function writeProjectFile(
  directory: string,
  name: string,
  document: unknown,
): void {
  writeFileSync(
    join(directory, name),
    `${JSON.stringify(document, null, 2)}\n`,
    "utf8",
  );
}

export function compileScaffoldProject(
  project: ScaffoldProject,
): CompileResult {
  const result = spawnSync(
    process.execPath,
    [
      compilerPath,
      "-p",
      join(project.directory, "tsconfig.json"),
      "--pretty",
      "false",
    ],
    { encoding: "utf8" },
  );
  if (result.error !== undefined) throw result.error;
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** Formats, lints, and organizes imports over the project's sources. */
export function checkScaffoldProject(project: ScaffoldProject): CompileResult {
  const result = spawnSync(
    process.execPath,
    [
      join(repositoryRoot, "node_modules/@biomejs/biome/bin/biome"),
      "check",
      "src",
    ],
    { cwd: project.directory, encoding: "utf8" },
  );
  if (result.error !== undefined) throw result.error;
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** Runs one compiled module with the project directory as its working directory. */
export function runCompiledModule(
  project: ScaffoldProject,
  relativePath: string,
  environment: Readonly<Record<string, string>> = {},
): RunResult {
  const result = spawnSync(process.execPath, [relativePath], {
    cwd: project.directory,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", ...environment },
  });
  if (result.error !== undefined) throw result.error;
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/** Removes the project directory; the symlinked dependencies are not followed. */
export function removeScaffoldProject(project: ScaffoldProject): void {
  rmSync(project.directory, { recursive: true, force: true });
}
