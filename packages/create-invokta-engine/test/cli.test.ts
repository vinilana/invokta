import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type CreateEngineIo,
  type CreateEngineTerminal,
  type InstallProject,
  runCreateEngineCli,
} from "../src/cli.js";
import { createStarterFiles } from "../src/starter.js";

const temporaryDirectories: string[] = [];

function createWorkingDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "invokta-creator-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}

function createHarness(
  overrides: Partial<CreateEngineIo> = {},
): CreateEngineIo & { readonly stdout: string[]; readonly stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    writeStdout:
      overrides.writeStdout ??
      ((text) => {
        stdout.push(text);
      }),
    writeStderr:
      overrides.writeStderr ??
      ((text) => {
        stderr.push(text);
      }),
  };
}

const encoder = new TextEncoder();

function promptLine(value: string): Uint8Array {
  return encoder.encode(`${value}\n`);
}

type PromptFixture = Uint8Array | undefined | Error;

function createTerminal(
  answers: readonly PromptFixture[],
  options: Readonly<{ stdinIsTty?: boolean; stderrIsTty?: boolean }> = {},
): CreateEngineTerminal & {
  readonly readLine: ReturnType<typeof vi.fn<CreateEngineTerminal["readLine"]>>;
} {
  const pending = [...answers];
  const readLine = vi.fn<CreateEngineTerminal["readLine"]>(async () => {
    const answer = pending.shift();
    if (answer instanceof Error) throw answer;
    return answer;
  });
  return {
    stdinIsTty: options.stdinIsTty ?? true,
    stderrIsTty: options.stderrIsTty ?? true,
    readLine,
  };
}

const invalidArgumentCases: readonly Readonly<{
  argv: readonly string[];
}>[] = [
  { argv: ["my-engine", "other-engine"] },
  { argv: ["my-engine", "--unknown"] },
  { argv: ["my-engine", "--no-install", "--no-install"] },
  { argv: ["my-engine", "--package-manager"] },
  { argv: ["my-engine", "--package-manager", "bun"] },
  { argv: ["my-engine", "--profile"] },
  { argv: ["my-engine", "--profile", "fixture-secret-payload-marker"] },
  { argv: ["my-engine", "--profile", "cli", "--profile", "mcp-http"] },
  { argv: ["--yes"] },
  { argv: ["my-engine", "--yes", "--yes"] },
  {
    argv: [
      "my-engine",
      "--package-manager",
      "npm",
      "--package-manager",
      "pnpm",
    ],
  },
  { argv: ["--help", "my-engine"] },
  { argv: ["--version", "fixture-secret-payload-marker"] },
];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("runCreateEngineCli", () => {
  it("prompts for directory, profile, and confirmation in order before writing", async () => {
    const cwd = createWorkingDirectory();
    const io = createHarness();
    const install = vi.fn<InstallProject>();
    const target = join(cwd, "my-engine");
    let reads = 0;
    const terminal = createTerminal([
      promptLine("my-engine"),
      promptLine("2"),
      promptLine("yes"),
    ]);
    terminal.readLine.mockImplementation(async () => {
      reads += 1;
      expect(existsSync(target)).toBe(false);
      return [promptLine("my-engine"), promptLine("2"), promptLine("yes")][
        reads - 1
      ];
    });

    const exitCode = await runCreateEngineCli({
      argv: ["--no-install"],
      cwd,
      env: {},
      io,
      terminal,
      install,
      loadPackageVersion: async () => "1.2.3",
    });

    expect(exitCode).toBe(0);
    expect(terminal.readLine).toHaveBeenCalledTimes(3);
    expect(io.stderr).toEqual([
      "Project directory (my-invokta-engine): ",
      "Scaffold profile:\n" +
        "  1. Complete (CLI + MCP local + MCP HTTP)\n" +
        "  2. MCP local (stdio)\n" +
        "  3. MCP HTTP\n" +
        "  4. CLI\n" +
        "Choose a profile (1): ",
      'Create the MCP local scaffold in "my-engine" without installing dependencies? (y/N) ',
    ]);
    expect(io.stdout.join("")).toContain(
      "Created my-engine with the MCP local scaffold.",
    );
    expect(existsSync(join(target, "src/cli.ts"))).toBe(false);
    expect(existsSync(join(target, "src/mcp-stdio.ts"))).toBe(true);
    expect(install).not.toHaveBeenCalled();
  });

  it("skips supplied questions but retains terminal confirmation", async () => {
    const cwd = createWorkingDirectory();
    const io = createHarness();
    const terminal = createTerminal([promptLine(" yEs ")]);

    const exitCode = await runCreateEngineCli({
      argv: ["engines/./my-engine", "--profile", "cli", "--no-install"],
      cwd,
      env: {},
      io,
      terminal,
      loadPackageVersion: async () => "1.2.3",
    });

    expect(exitCode).toBe(0);
    expect(terminal.readLine).toHaveBeenCalledOnce();
    expect(io.stderr).toEqual([
      'Create the CLI scaffold in "engines/my-engine" without installing dependencies? (y/N) ',
    ]);
    expect(io.stderr.join("")).not.toContain(cwd);
  });

  it("uses empty directory and profile defaults, while empty confirmation cancels", async () => {
    const cwd = createWorkingDirectory();
    const io = createHarness();
    const terminal = createTerminal([
      promptLine(""),
      promptLine(""),
      promptLine(""),
    ]);
    const install = vi.fn<InstallProject>();

    const exitCode = await runCreateEngineCli({
      argv: [],
      cwd,
      env: {},
      io,
      terminal,
      install,
      loadPackageVersion: async () => "1.2.3",
    });

    expect(exitCode).toBe(0);
    expect(io.stdout).toEqual(["Creation cancelled. No files were created.\n"]);
    expect(io.stderr).toHaveLength(3);
    expect(existsSync(join(cwd, "my-invokta-engine"))).toBe(false);
    expect(install).not.toHaveBeenCalled();
  });

  it.each(["n", "No"])(
    "treats %s confirmation as normal cancellation",
    async (answer) => {
      const cwd = createWorkingDirectory();
      const io = createHarness();
      const terminal = createTerminal([promptLine(answer)]);
      const install = vi.fn<InstallProject>();

      const exitCode = await runCreateEngineCli({
        argv: ["my-engine", "--profile", "mcp-http"],
        cwd,
        io,
        terminal,
        install,
        loadPackageVersion: async () => "1.2.3",
      });

      expect(exitCode).toBe(0);
      expect(io.stdout).toEqual([
        "Creation cancelled. No files were created.\n",
      ]);
      expect(existsSync(join(cwd, "my-engine"))).toBe(false);
      expect(install).not.toHaveBeenCalled();
    },
  );

  it("never prompts in non-terminal mode and defaults to complete", async () => {
    const cwd = createWorkingDirectory();
    const io = createHarness();
    const terminal = createTerminal([], { stderrIsTty: false });

    const exitCode = await runCreateEngineCli({
      argv: ["my-engine", "--no-install"],
      cwd,
      env: {},
      io,
      terminal,
      loadPackageVersion: async () => "1.2.3",
    });

    expect(exitCode).toBe(0);
    expect(terminal.readLine).not.toHaveBeenCalled();
    expect(existsSync(join(cwd, "my-engine/src/cli.ts"))).toBe(true);
    expect(existsSync(join(cwd, "my-engine/src/mcp-stdio.ts"))).toBe(true);
    expect(existsSync(join(cwd, "my-engine/src/mcp-http.ts"))).toBe(true);
  });

  it("fails non-terminal execution without a target before loading or writing", async () => {
    const cwd = createWorkingDirectory();
    const io = createHarness();
    const terminal = createTerminal([], { stdinIsTty: false });
    const install = vi.fn<InstallProject>();
    const loadPackageVersion = vi.fn<() => Promise<string>>();

    const exitCode = await runCreateEngineCli({
      argv: [],
      cwd,
      io,
      terminal,
      install,
      loadPackageVersion,
    });

    expect(exitCode).toBe(2);
    expect(io.stdout).toEqual([]);
    expect(io.stderr).toEqual([
      "INTERACTIVE_REQUIRED: Interactive input is required when no project directory is provided.\n",
    ]);
    expect(terminal.readLine).not.toHaveBeenCalled();
    expect(loadPackageVersion).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    expect(readdirSync(cwd)).toEqual([]);
  });

  it("lets --yes bypass every prompt in a terminal", async () => {
    const cwd = createWorkingDirectory();
    const io = createHarness();
    const terminal = createTerminal([new Error("must not read")]);

    const exitCode = await runCreateEngineCli({
      argv: ["my-engine", "--profile", "cli", "--no-install", "--yes"],
      cwd,
      io,
      terminal,
      loadPackageVersion: async () => "1.2.3",
    });

    expect(exitCode).toBe(0);
    expect(terminal.readLine).not.toHaveBeenCalled();
    expect(io.stderr).toEqual([]);
    expect(existsSync(join(cwd, "my-engine/src/cli.ts"))).toBe(true);
    expect(existsSync(join(cwd, "my-engine/src/mcp-stdio.ts"))).toBe(false);
  });

  it("accepts two invalid prompt answers and then a valid answer", async () => {
    const cwd = createWorkingDirectory();
    const io = createHarness();
    const terminal = createTerminal([
      promptLine("../secret-target"),
      promptLine("Invalid Name"),
      promptLine("my-engine"),
      promptLine("9"),
      promptLine("complete"),
      promptLine(" 4 "),
      promptLine("maybe"),
      promptLine("later"),
      promptLine("YES"),
    ]);

    const exitCode = await runCreateEngineCli({
      argv: ["--no-install"],
      cwd,
      io,
      terminal,
      loadPackageVersion: async () => "1.2.3",
    });

    expect(exitCode).toBe(0);
    expect(terminal.readLine).toHaveBeenCalledTimes(9);
    expect(io.stderr.join("")).not.toContain("secret-target");
    expect(existsSync(join(cwd, "my-engine/src/cli.ts"))).toBe(true);
  });

  it.each([
    [
      "three invalid answers",
      [promptLine("9"), promptLine("8"), promptLine("7")],
      "PROMPT_INVALID",
      2,
    ],
    [
      "one byte beyond the answer limit",
      [encoder.encode(`${" ".repeat(4_096)}\n`)],
      "PROMPT_INVALID",
      2,
    ],
    [
      "malformed UTF-8",
      [Uint8Array.from([0xc3, 0x28, 0x0a])],
      "PROMPT_INVALID",
      2,
    ],
    ["end of file", [undefined], "PROMPT_ABORTED", 1],
    [
      "terminal interruption",
      [new Error("fixture interrupt")],
      "PROMPT_ABORTED",
      1,
    ],
  ] as const)(
    "fails on %s without creating or installing",
    async (_label, answers, code, expectedExit) => {
      const cwd = createWorkingDirectory();
      const io = createHarness();
      const terminal = createTerminal(answers);
      const install = vi.fn<InstallProject>();

      const exitCode = await runCreateEngineCli({
        argv: ["my-engine", "--no-install"],
        cwd,
        io,
        terminal,
        install,
        loadPackageVersion: async () => "1.2.3",
      });

      expect(exitCode).toBe(expectedExit);
      expect(io.stdout).toEqual([]);
      expect(io.stderr.at(-1)).toMatch(new RegExp(`^${code}:`));
      expect(io.stderr.join("")).not.toContain("fixture interrupt");
      expect(existsSync(join(cwd, "my-engine"))).toBe(false);
      expect(install).not.toHaveBeenCalled();
    },
  );

  it("accepts an exact 4,096-byte line without treating it as overflow", async () => {
    const cwd = createWorkingDirectory();
    const io = createHarness();
    const exactBoundary = encoder.encode(`${" ".repeat(4_095)}\n`);
    const terminal = createTerminal([
      exactBoundary,
      promptLine("1"),
      promptLine("yes"),
    ]);

    const exitCode = await runCreateEngineCli({
      argv: ["my-engine", "--no-install"],
      cwd,
      io,
      terminal,
      loadPackageVersion: async () => "1.2.3",
    });

    expect(exitCode).toBe(0);
    expect(terminal.readLine).toHaveBeenCalledTimes(3);
  });

  it("normalizes a broken prompt writer as an aborted prompt", async () => {
    const cwd = createWorkingDirectory();
    const io = createHarness({
      writeStderr: async () => {
        throw new Error("fixture prompt output secret");
      },
    });
    const terminal = createTerminal([promptLine("yes")]);

    const exitCode = await runCreateEngineCli({
      argv: ["my-engine", "--profile", "cli"],
      cwd,
      io,
      terminal,
      loadPackageVersion: async () => "1.2.3",
    });

    expect(exitCode).toBe(1);
    expect(terminal.readLine).not.toHaveBeenCalled();
    expect(existsSync(join(cwd, "my-engine"))).toBe(false);
  });

  it("starts installation only after every selected entry exists", async () => {
    const cwd = createWorkingDirectory();
    const io = createHarness();
    const expectedFiles = createStarterFiles({
      projectName: "my-engine",
      invoktaVersion: "1.2.3",
      packageManager: "npm",
      profile: "mcp-http",
    });
    const install = vi.fn<InstallProject>(async ({ directory }) => {
      for (const file of expectedFiles) {
        expect(existsSync(join(directory, file.path))).toBe(true);
      }
    });

    const exitCode = await runCreateEngineCli({
      argv: ["my-engine", "--profile", "mcp-http"],
      cwd,
      env: {},
      io,
      terminal: createTerminal([], { stdinIsTty: false }),
      install,
      loadPackageVersion: async () => "1.2.3",
    });

    expect(exitCode).toBe(0);
    expect(install).toHaveBeenCalledOnce();
  });

  it("creates without installing when --no-install is present", async () => {
    const cwd = createWorkingDirectory();
    const io = createHarness();
    const install = vi.fn<InstallProject>();

    const exitCode = await runCreateEngineCli({
      argv: ["my-engine", "--no-install"],
      cwd,
      env: {},
      io,
      install,
      loadPackageVersion: async () => "1.2.3",
    });

    expect(exitCode).toBe(0);
    expect(install).not.toHaveBeenCalled();
    expect(io.stderr).toEqual([]);
    expect(io.stdout.join("")).toBe(
      "Created my-engine with the complete scaffold.\n\n" +
        "Next steps:\n" +
        "  npm install --no-audit --no-fund\n" +
        "  npm run check\n",
    );
    expect(
      JSON.parse(readFileSync(join(cwd, "my-engine/package.json"), "utf8")),
    ).toMatchObject({
      name: "my-engine",
      dependencies: { "@invokta/core": "1.2.3" },
    });
  });

  it("installs once after the complete scaffold using the inferred manager", async () => {
    const cwd = createWorkingDirectory();
    const io = createHarness();
    const install = vi.fn<InstallProject>(
      async ({ directory, packageManager }) => {
        expect(packageManager).toBe("pnpm");
        expect(existsSync(join(directory, "src/engine.ts"))).toBe(true);
      },
    );

    const exitCode = await runCreateEngineCli({
      argv: ["my-engine"],
      cwd,
      env: { npm_config_user_agent: "pnpm/10.14.0 npm/? node/v22.20.0" },
      io,
      install,
      loadPackageVersion: async () => "1.2.3",
    });

    expect(exitCode).toBe(0);
    expect(install).toHaveBeenCalledOnce();
    expect(io.stderr).toEqual([]);
    expect(io.stdout.join("")).toBe(
      "Created my-engine with the complete scaffold.\n\n" +
        "Next step:\n  pnpm run check\n",
    );
  });

  it("uses an explicit package manager instead of the inferred manager", async () => {
    const cwd = createWorkingDirectory();
    const io = createHarness();
    const install = vi.fn<InstallProject>(async () => undefined);

    await runCreateEngineCli({
      argv: ["--package-manager", "yarn", "my-engine"],
      cwd,
      env: { npm_config_user_agent: "pnpm/10.14.0" },
      io,
      install,
      loadPackageVersion: async () => "1.2.3",
    });

    expect(install).toHaveBeenCalledWith({
      directory: join(cwd, "my-engine"),
      packageManager: "yarn",
    });
    expect(readFileSync(join(cwd, "my-engine/README.md"), "utf8")).toContain(
      "yarn run check",
    );
    expect(io.stdout.join("")).toContain("yarn run check");
  });

  it("preserves the complete scaffold when installation fails", async () => {
    const cwd = createWorkingDirectory();
    const io = createHarness();

    const exitCode = await runCreateEngineCli({
      argv: ["my-engine"],
      cwd,
      env: {},
      io,
      install: async () => {
        const { CreatorError } = await import("../src/errors.js");
        throw new CreatorError("INSTALL_FAILED", ["npm"]);
      },
      loadPackageVersion: async () => "1.2.3",
    });

    expect(exitCode).toBe(1);
    expect(io.stdout).toEqual([]);
    expect(io.stderr.join("")).toBe(
      "INSTALL_FAILED: The project dependencies could not be installed.\n" +
        "  npm\n",
    );
    expect(existsSync(join(cwd, "my-engine/package.json"))).toBe(true);
    expect(readdirSync(join(cwd, "my-engine"))).toHaveLength(13);
  });

  it.each(invalidArgumentCases)(
    "rejects invalid arguments without creating a project: $argv",
    async ({ argv }) => {
      const cwd = createWorkingDirectory();
      const io = createHarness();
      const install = vi.fn<InstallProject>();

      const exitCode = await runCreateEngineCli({
        argv,
        cwd,
        env: {},
        io,
        install,
      });

      expect(exitCode).toBe(2);
      expect(io.stdout).toEqual([]);
      expect(io.stderr).toEqual([
        'Invalid arguments. Run "create-invokta-engine --help".\n',
      ]);
      expect(io.stderr.join("")).not.toContain("fixture-secret-payload-marker");
      expect(install).not.toHaveBeenCalled();
      expect(readdirSync(cwd)).toEqual([]);
    },
  );

  it("prints help without loading the package version", async () => {
    const io = createHarness();
    const loadPackageVersion = vi.fn<() => Promise<string>>();

    const exitCode = await runCreateEngineCli({
      argv: ["--help"],
      io,
      loadPackageVersion,
    });

    expect(exitCode).toBe(0);
    expect(loadPackageVersion).not.toHaveBeenCalled();
    expect(io.stderr).toEqual([]);
    expect(io.stdout.join("")).toContain(
      "create-invokta-engine [project-directory]",
    );
  });

  it("prints the loaded package version", async () => {
    const io = createHarness();

    const exitCode = await runCreateEngineCli({
      argv: ["--version"],
      io,
      loadPackageVersion: async () => "1.2.3",
    });

    expect(exitCode).toBe(0);
    expect(io.stderr).toEqual([]);
    expect(io.stdout).toEqual(["1.2.3\n"]);
  });

  it("renders a target error without echoing the rejected path", async () => {
    const cwd = createWorkingDirectory();
    const io = createHarness();

    const exitCode = await runCreateEngineCli({
      argv: ["../fixture-secret-payload-marker", "--no-install"],
      cwd,
      io,
      loadPackageVersion: async () => "1.2.3",
    });

    expect(exitCode).toBe(2);
    expect(io.stdout).toEqual([]);
    expect(io.stderr.join("")).toBe(
      "TARGET_INVALID: The project path or name is invalid.\n",
    );
    expect(io.stderr.join("")).not.toContain("fixture-secret-payload-marker");
  });

  it("contains a rejected diagnostic writer", async () => {
    const cwd = createWorkingDirectory();
    writeFileSync(join(cwd, "sentinel"), "mine\n", "utf8");
    const io = createHarness({
      writeStderr: async () => {
        throw new Error("closed diagnostic stream");
      },
    });

    await expect(
      runCreateEngineCli({
        argv: ["my-engine", "--unknown"],
        cwd,
        io,
      }),
    ).resolves.toBe(2);
  });
});
