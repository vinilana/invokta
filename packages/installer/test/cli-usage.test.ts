import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { InstallerError } from "../src/installer-error.js";
import { runInstallerCli } from "../src/run-installer-cli.js";

const helpText = `Usage:
  invokta-installer
  invokta-installer install --engine <project-directory>
  invokta-installer status
  invokta-installer enable
  invokta-installer disable
  invokta-installer remove
  invokta-installer --help
  invokta-installer --version
`;
const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { readonly version: string };

interface TestIoOptions {
  readonly inputIsTTY?: boolean;
  readonly outputIsTTY?: boolean;
}

function createIo(options: TestIoOptions = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const inputIsTTY = vi.fn(() => options.inputIsTTY ?? true);
  const outputIsTTY = vi.fn(() => options.outputIsTTY ?? true);
  return {
    io: {
      inputIsTTY,
      outputIsTTY,
      writeStdout: vi.fn((text: string) => {
        stdout.push(text);
      }),
      writeStderr: vi.fn((text: string) => {
        stderr.push(text);
      }),
    },
    inputIsTTY,
    outputIsTTY,
    stdout,
    stderr,
  };
}

describe("runInstallerCli", () => {
  it("writes the exact help text without loading the interactive application", async () => {
    const output = createIo();
    const loadInteractiveSession = vi.fn(async () => 0 as const);
    const loadPackageVersion = vi.fn(async () => manifest.version);

    const result = await runInstallerCli({
      argv: ["--help"],
      io: output.io,
      loadInteractiveSession,
      loadPackageVersion,
    });

    expect(result).toBe(0);
    expect(output.stdout).toEqual([helpText]);
    expect(output.stderr).toEqual([]);
    expect(output.inputIsTTY).not.toHaveBeenCalled();
    expect(output.outputIsTTY).not.toHaveBeenCalled();
    expect(loadInteractiveSession).not.toHaveBeenCalled();
    expect(loadPackageVersion).not.toHaveBeenCalled();
  });

  it("writes only the manifest version without loading the interactive application", async () => {
    const output = createIo();
    const loadInteractiveSession = vi.fn(async () => 0 as const);

    const result = await runInstallerCli({
      argv: ["--version"],
      io: output.io,
      loadInteractiveSession,
    });

    expect(result).toBe(0);
    expect(output.stdout).toEqual([`${manifest.version}\n`]);
    expect(output.stderr).toEqual([]);
    expect(output.inputIsTTY).not.toHaveBeenCalled();
    expect(output.outputIsTTY).not.toHaveBeenCalled();
    expect(loadInteractiveSession).not.toHaveBeenCalled();
  });

  it("renders the version supplied by the package-manifest loader", async () => {
    const output = createIo();
    const loadInteractiveSession = vi.fn(async () => 0 as const);
    const loadPackageVersion = vi.fn(async () => "9.8.7");

    const result = await runInstallerCli({
      argv: ["--version"],
      io: output.io,
      loadInteractiveSession,
      loadPackageVersion,
    });

    expect(result).toBe(0);
    expect(output.stdout).toEqual(["9.8.7\n"]);
    expect(loadPackageVersion).toHaveBeenCalledTimes(1);
    expect(loadInteractiveSession).not.toHaveBeenCalled();
  });

  it.each([
    ["--unknown"],
    ["--help", "extra"],
    ["--version", "extra"],
    ["-h"],
    ["-v"],
    [""],
  ])("rejects every undocumented argument vector: %j", async (...argv) => {
    const output = createIo();
    const loadInteractiveSession = vi.fn(async () => 0 as const);
    const loadPackageVersion = vi.fn(async () => manifest.version);

    const result = await runInstallerCli({
      argv,
      io: output.io,
      loadInteractiveSession,
      loadPackageVersion,
    });

    expect(result).toBe(2);
    expect(output.stdout).toEqual([]);
    expect(output.stderr).toEqual([
      'Invalid arguments. Run "invokta-installer --help".\n',
    ]);
    expect(output.inputIsTTY).not.toHaveBeenCalled();
    expect(output.outputIsTTY).not.toHaveBeenCalled();
    expect(loadInteractiveSession).not.toHaveBeenCalled();
    expect(loadPackageVersion).not.toHaveBeenCalled();
  });

  it.each([
    { inputIsTTY: false, outputIsTTY: true },
    { inputIsTTY: true, outputIsTTY: false },
    { inputIsTTY: false, outputIsTTY: false },
  ])(
    "fails closed before interactive loading without both TTYs: %j",
    async (tty) => {
      const output = createIo(tty);
      const loadInteractiveSession = vi.fn(async () => 0 as const);
      const loadPackageVersion = vi.fn(async () => manifest.version);

      const result = await runInstallerCli({
        argv: [],
        io: output.io,
        loadInteractiveSession,
        loadPackageVersion,
      });

      expect(result).toBe(2);
      expect(output.stdout).toEqual([]);
      expect(output.stderr).toEqual([
        "NO_TTY: The installer requires an interactive terminal.\n",
      ]);
      expect(loadInteractiveSession).not.toHaveBeenCalled();
      expect(loadPackageVersion).not.toHaveBeenCalled();
    },
  );

  it.each([0, 1, 2, 130] as const)(
    "starts the lazy interactive application and preserves exit code %i",
    async (exitCode) => {
      const output = createIo();
      const loadInteractiveSession = vi.fn(async () => exitCode);
      const originalExitCode = process.exitCode;

      const result = await runInstallerCli({
        argv: [],
        io: output.io,
        loadInteractiveSession,
      });

      expect(result).toBe(exitCode);
      expect(process.exitCode).toBe(originalExitCode);
      expect(loadInteractiveSession).toHaveBeenCalledTimes(1);
      expect(output.stdout).toEqual([]);
      expect(output.stderr).toEqual([]);
    },
  );

  it("parses a project-local engine installation before lazy interactive loading", async () => {
    const output = createIo();
    const loadInteractiveSession = vi.fn(async () => 0 as const);

    const result = await runInstallerCli({
      argv: ["install", "--engine", "projects/support-engine"],
      io: output.io,
      loadInteractiveSession,
    });

    expect(result).toBe(0);
    expect(loadInteractiveSession).toHaveBeenCalledWith({
      kind: "install-engine",
      projectDirectory: "projects/support-engine",
    });
    expect(output.stdout).toEqual([]);
    expect(output.stderr).toEqual([]);
  });

  it.each(["status", "enable", "disable", "remove"] as const)(
    "parses the %s lifecycle command",
    async (kind) => {
      const output = createIo();
      const loadInteractiveSession = vi.fn(async () => 0 as const);

      const result = await runInstallerCli({
        argv: [kind],
        io: output.io,
        loadInteractiveSession,
      });

      expect(result).toBe(0);
      expect(loadInteractiveSession).toHaveBeenCalledWith({ kind });
    },
  );

  it("maps a stable operational failure to exit code 1", async () => {
    const output = createIo();

    const result = await runInstallerCli({
      argv: ["install", "--engine", "."],
      io: output.io,
      loadInteractiveSession: async () => {
        throw new InstallerError("ENGINE_ENTRYPOINT_MISSING");
      },
    });

    expect(result).toBe(1);
    expect(output.stderr).toEqual([
      "ENGINE_ENTRYPOINT_MISSING: The Action Engine entry point was not found.\n",
    ]);
  });

  it("sanitizes an unexpected interactive initialization failure", async () => {
    const output = createIo();
    const loadInteractiveSession = vi.fn(async () => {
      throw new Error("secret path: /srv/private/registry.json");
    });

    const result = await runInstallerCli({
      argv: [],
      io: output.io,
      loadInteractiveSession,
    });

    expect(result).toBe(2);
    expect(output.stdout).toEqual([]);
    expect(output.stderr).toEqual([
      "INSTALLER_INITIALIZATION_FAILED: The installer could not be initialized.\n",
    ]);
    expect(output.stderr.join("")).not.toContain("secret path");
    expect(output.stderr.join("")).not.toContain("stack");
  });
});
