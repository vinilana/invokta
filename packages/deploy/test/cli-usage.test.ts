import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { runDeployCli } from "../src/cli.js";
import { DeployError } from "../src/errors.js";
import type { DeployContext } from "../src/io.js";

const helpText = `Usage:
  ai-engine-deploy init
  ai-engine-deploy package
  ai-engine-deploy probe --url <url> [--expect alive|ready] [--bearer-env NAME]
                         [--host-header HOST] [--timeout-ms N]
  ai-engine-deploy --help
  ai-engine-deploy --version
`;
const invalidUsageText = 'Invalid arguments. Run "ai-engine-deploy --help".\n';
const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { readonly version: string };
const secret = "sentinel-value-that-must-never-be-echoed";

function createIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      writeStdout: vi.fn((text: string) => {
        stdout.push(text);
      }),
      writeStderr: vi.fn((text: string) => {
        stderr.push(text);
      }),
    },
    stdout,
    stderr,
  };
}

function createCommands() {
  return {
    init: vi.fn(async () => 0 as const),
    package: vi.fn(async () => 0 as const),
    probe: vi.fn(async () => 0 as const),
  };
}

describe("runDeployCli usage", () => {
  it("writes the exact help text to stdout without loading a command", async () => {
    const output = createIo();
    const commands = createCommands();
    const loadPackageVersion = vi.fn(async () => manifest.version);

    const exitCode = await runDeployCli({
      argv: ["--help"],
      io: output.io,
      commands,
      loadPackageVersion,
    });

    expect(exitCode).toBe(0);
    expect(output.stdout).toEqual([helpText]);
    expect(output.stderr).toEqual([]);
    expect(commands.init).not.toHaveBeenCalled();
    expect(commands.package).not.toHaveBeenCalled();
    expect(commands.probe).not.toHaveBeenCalled();
    expect(loadPackageVersion).not.toHaveBeenCalled();
  });

  it("writes only the package version to stdout", async () => {
    const output = createIo();
    const commands = createCommands();

    const exitCode = await runDeployCli({
      argv: ["--version"],
      io: output.io,
      commands,
    });

    expect(exitCode).toBe(0);
    expect(output.stdout).toEqual([`${manifest.version}\n`]);
    expect(output.stderr).toEqual([]);
    expect(commands.init).not.toHaveBeenCalled();
  });

  it("renders the version supplied by the package-manifest loader", async () => {
    const output = createIo();
    const loadPackageVersion = vi.fn(async () => "9.8.7");

    const exitCode = await runDeployCli({
      argv: ["--version"],
      io: output.io,
      commands: createCommands(),
      loadPackageVersion,
    });

    expect(exitCode).toBe(0);
    expect(output.stdout).toEqual(["9.8.7\n"]);
    expect(loadPackageVersion).toHaveBeenCalledTimes(1);
  });

  it.each([
    [[]],
    [["--unknown"]],
    [["-h"]],
    [["-v"]],
    [["-"]],
    [[""]],
    [["Init"]],
    [["deploy"]],
    [["--help", "extra"]],
    [["--version", "extra"]],
    [["--help", "--version"]],
  ])("rejects the argument vector %j with one sanitized line", async (argv) => {
    const output = createIo();
    const commands = createCommands();

    const exitCode = await runDeployCli({
      argv,
      io: output.io,
      commands,
    });

    expect(exitCode).toBe(2);
    expect(output.stdout).toEqual([]);
    expect(output.stderr).toEqual([invalidUsageText]);
    expect(commands.init).not.toHaveBeenCalled();
    expect(commands.package).not.toHaveBeenCalled();
    expect(commands.probe).not.toHaveBeenCalled();
  });

  it("never echoes a rejected argument", async () => {
    const output = createIo();

    const exitCode = await runDeployCli({
      argv: [`--${secret}`],
      io: output.io,
      commands: createCommands(),
    });

    expect(exitCode).toBe(2);
    expect(output.stderr.join("")).not.toContain(secret);
  });
});

describe("runDeployCli dispatch", () => {
  it.each([["init"], ["package"], ["probe"]] as const)(
    "routes %s to its command module with the remaining arguments",
    async (name) => {
      const output = createIo();
      const commands = createCommands();

      const exitCode = await runDeployCli({
        argv: [name, "--url", "https://engine.example/mcp"],
        cwd: "/workspace/engine",
        env: { AI_ENGINE_HTTP_PORT: "3000" },
        io: output.io,
        commands,
      });

      expect(exitCode).toBe(0);
      expect(commands[name]).toHaveBeenCalledTimes(1);
      const call = commands[name].mock.calls[0] as unknown as [
        readonly string[],
        DeployContext,
      ];
      expect(call[0]).toEqual(["--url", "https://engine.example/mcp"]);
      expect(call[1].cwd).toBe("/workspace/engine");
      expect(call[1].env).toEqual({ AI_ENGINE_HTTP_PORT: "3000" });
      expect(output.stdout).toEqual([]);
      expect(output.stderr).toEqual([]);
    },
  );

  it.each([[0], [1], [2]] as const)(
    "returns the exit code %i chosen by the command",
    async (expected) => {
      const output = createIo();

      const exitCode = await runDeployCli({
        argv: ["package"],
        io: output.io,
        commands: { package: vi.fn(async () => expected) },
      });

      expect(exitCode).toBe(expected);
    },
  );

  it("renders a toolkit error raised by a command and adopts its exit code", async () => {
    const output = createIo();

    const exitCode = await runDeployCli({
      argv: ["package"],
      io: output.io,
      commands: {
        package: vi.fn(async () => {
          throw new DeployError("LOCKFILE_AMBIGUOUS", {
            details: ['"yarn.lock"', '"package-lock.json"'],
          });
        }),
      },
    });

    expect(exitCode).toBe(1);
    expect(output.stdout).toEqual([]);
    expect(output.stderr).toEqual([
      `LOCKFILE_AMBIGUOUS: More than one lockfile was found.
  "yarn.lock"
  "package-lock.json"
`,
    ]);
  });

  it("sanitizes an unexpected command failure", async () => {
    const output = createIo();

    const exitCode = await runDeployCli({
      argv: ["init"],
      io: output.io,
      commands: {
        init: vi.fn(async () => {
          throw new Error(`failed reading ${secret}`);
        }),
      },
    });

    expect(exitCode).toBe(2);
    expect(output.stdout).toEqual([]);
    expect(output.stderr).toEqual(["The command could not be completed.\n"]);
    expect(output.stderr.join("")).not.toContain(secret);
  });

  it("keeps the process exit code untouched", async () => {
    const original = process.exitCode;

    await runDeployCli({
      argv: ["probe"],
      io: createIo().io,
      commands: { probe: vi.fn(async () => 1 as const) },
    });

    expect(process.exitCode).toBe(original);
  });

  it("defaults the context to the process working directory and environment", async () => {
    const command = vi.fn(async () => 0 as const);

    await runDeployCli({
      argv: ["init"],
      io: createIo().io,
      commands: { init: command },
    });

    const call = command.mock.calls[0] as unknown as [
      readonly string[],
      DeployContext,
    ];
    expect(call[1].cwd).toBe(process.cwd());
    expect(call[1].env).toBe(process.env);
  });
});
