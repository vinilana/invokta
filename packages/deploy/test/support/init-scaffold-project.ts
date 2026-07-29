import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
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
  const directory = mkdtempSync(join(tmpdir(), "invokta-scaffold-"));
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

/** Reported by the harness when an override did not survive the replacement. */
export const environmentOverrideLostStatus = 9;

/**
 * Runs one compiled module against an environment carrying values the platform
 * itself cannot hold. A POSIX environment block is NUL-terminated, so neither a
 * spawn environment nor `process.env` can carry a NUL: Node rejects the first
 * and truncates the second. The harness therefore replaces `process.env` with a
 * plain object before importing the module, and verifies every override
 * round-trips first, so a silently lost value fails loudly instead of starting
 * a server with a truncated value.
 */
export function runCompiledModuleWithReplacedEnv(
  project: ScaffoldProject,
  relativePath: string,
  overrides: Readonly<Record<string, string>>,
  environment: Readonly<Record<string, string>> = {},
): RunResult {
  const script = [
    `const overrides = ${JSON.stringify(overrides)};`,
    "const replacement = { ...process.env, ...overrides };",
    'Object.defineProperty(process, "env", {',
    "  configurable: true,",
    "  enumerable: true,",
    "  value: replacement,",
    "  writable: true,",
    "});",
    "for (const [name, value] of Object.entries(overrides)) {",
    "  if (process.env[name] === value) continue;",
    '  process.stderr.write("ENVIRONMENT_OVERRIDE_LOST: " + name + "\\n");',
    `  process.exit(${String(environmentOverrideLostStatus)});`,
    "}",
    `await import(${JSON.stringify(`./${relativePath}`)});`,
  ].join("\n");

  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    {
      cwd: project.directory,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", ...environment },
      timeout: 30_000,
    },
  );
  if (result.error !== undefined) throw result.error;
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export interface StartedModule {
  /** The port named by the composition root's own announcement. */
  readonly port: number;
  readonly host: string;
  /** Everything written to stderr so far. */
  stderr(): string;
  /** Resolves once the marker appears on stderr. */
  waitForStderr(marker: string, timeoutMs?: number): Promise<void>;
  signal(name: NodeJS.Signals): void;
  /** Resolves with the exit status, killing the process if it overruns. */
  exit(timeoutMs?: number): Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;
  kill(): void;
}

/** Reserves a free TCP port and releases it, so a fixture can name it. */
export async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("The reserved address is not a TCP address."));
        return;
      }
      resolve(address.port);
    });
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const announcement = /MCP endpoint: http:\/\/(.+):(\d+)\/mcp/;

/**
 * Starts a compiled composition root and resolves once it has announced its
 * endpoint, so a test observes the port it really bound rather than the port it
 * was asked for.
 */
export async function startCompiledModule(
  project: ScaffoldProject,
  relativePath: string,
  environment: Readonly<Record<string, string>> = {},
  timeoutMs = 20_000,
): Promise<StartedModule> {
  const child = spawn(process.execPath, [relativePath], {
    cwd: project.directory,
    env: { PATH: process.env.PATH ?? "", ...environment },
  });
  child.stderr.setEncoding("utf8");
  let stderr = "";
  const waiters: Array<() => void> = [];
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    for (const notify of waiters.splice(0)) notify();
  });

  const kill = (): void => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  };

  const waitForStderr = (marker: string, waitMs = 10_000): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`stderr never carried ${marker}: ${stderr}`));
      }, waitMs);
      const check = (): void => {
        if (!stderr.includes(marker)) {
          waiters.push(check);
          return;
        }
        clearTimeout(timer);
        resolve();
      };
      child.once("exit", () => {
        clearTimeout(timer);
        if (stderr.includes(marker)) resolve();
        else
          reject(new Error(`the process exited before ${marker}: ${stderr}`));
      });
      check();
    });

  try {
    await waitForStderr("MCP endpoint:", timeoutMs);
  } catch (error) {
    kill();
    throw error;
  }
  const match = announcement.exec(stderr);
  if (match?.[1] === undefined || match[2] === undefined) {
    kill();
    throw new Error(`the announcement is unreadable: ${stderr}`);
  }

  return {
    host: match[1],
    port: Number(match[2]),
    stderr: () => stderr,
    waitForStderr,
    signal: (name) => {
      child.kill(name);
    },
    exit: (waitMs = 15_000) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          kill();
        }, waitMs);
        child.once("exit", (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal });
        });
        if (child.exitCode !== null || child.signalCode !== null) {
          clearTimeout(timer);
          resolve({ code: child.exitCode, signal: child.signalCode });
        }
      }),
    kill,
  };
}

/** Removes the project directory; the symlinked dependencies are not followed. */
export function removeScaffoldProject(project: ScaffoldProject): void {
  rmSync(project.directory, { recursive: true, force: true });
}
