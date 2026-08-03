import { describe, expect, it, vi } from "vitest";

import { runEngineInstallerCli } from "../src/engine-cli.js";
import { InstallerError } from "../src/installer-error.js";

const helpText = `Usage:
  support-engine install
  support-engine uninstall
  support-engine --help
`;
const packageRoot = "/opt/engines/support-engine";

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

describe("runEngineInstallerCli", () => {
  it("writes the exact help text without loading the interactive application", async () => {
    const output = createIo();
    const loadInteractiveSession = vi.fn(async () => 0 as const);

    const result = await runEngineInstallerCli({
      argv: ["--help"],
      binaryName: "support-engine",
      io: output.io,
      loadInteractiveSession,
      packageRoot,
    });

    expect(result).toBe(0);
    expect(output.stdout).toEqual([helpText]);
    expect(output.stderr).toEqual([]);
    expect(output.inputIsTTY).not.toHaveBeenCalled();
    expect(output.outputIsTTY).not.toHaveBeenCalled();
    expect(loadInteractiveSession).not.toHaveBeenCalled();
  });

  it.each([
    [],
    ["--unknown"],
    ["install", "extra"],
    ["uninstall", "extra"],
    ["--help", "extra"],
    ["install", "--engine", "."],
    ["remove"],
    ["--version"],
    [""],
  ])("rejects every undocumented argument vector: %j", async (...argv) => {
    const output = createIo();
    const loadInteractiveSession = vi.fn(async () => 0 as const);

    const result = await runEngineInstallerCli({
      argv,
      binaryName: "support-engine",
      io: output.io,
      loadInteractiveSession,
      packageRoot,
    });

    expect(result).toBe(2);
    expect(output.stdout).toEqual([]);
    expect(output.stderr).toEqual([
      'Invalid arguments. Run "support-engine --help".\n',
    ]);
    expect(output.inputIsTTY).not.toHaveBeenCalled();
    expect(output.outputIsTTY).not.toHaveBeenCalled();
    expect(loadInteractiveSession).not.toHaveBeenCalled();
  });

  it("maps install onto the engine installation session for the package root", async () => {
    const output = createIo();
    const loadInteractiveSession = vi.fn(async () => 0 as const);

    const result = await runEngineInstallerCli({
      argv: ["install"],
      binaryName: "support-engine",
      io: output.io,
      loadInteractiveSession,
      packageRoot,
    });

    expect(result).toBe(0);
    expect(loadInteractiveSession).toHaveBeenCalledWith({
      kind: "install-engine",
      projectDirectory: packageRoot,
    });
    expect(output.stdout).toEqual([]);
    expect(output.stderr).toEqual([]);
  });

  it("maps uninstall onto the engine-scoped removal session for the package root", async () => {
    const output = createIo();
    const loadInteractiveSession = vi.fn(async () => 0 as const);

    const result = await runEngineInstallerCli({
      argv: ["uninstall"],
      binaryName: "support-engine",
      io: output.io,
      loadInteractiveSession,
      packageRoot,
    });

    expect(result).toBe(0);
    expect(loadInteractiveSession).toHaveBeenCalledWith({
      kind: "remove-engine",
      projectDirectory: packageRoot,
    });
    expect(output.stdout).toEqual([]);
    expect(output.stderr).toEqual([]);
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

      const result = await runEngineInstallerCli({
        argv: ["install"],
        binaryName: "support-engine",
        io: output.io,
        loadInteractiveSession,
        packageRoot,
      });

      expect(result).toBe(2);
      expect(output.stdout).toEqual([]);
      expect(output.stderr).toEqual([
        "NO_TTY: The installer requires an interactive terminal.\n",
      ]);
      expect(loadInteractiveSession).not.toHaveBeenCalled();
    },
  );

  it.each([0, 1, 2, 130] as const)(
    "starts the lazy interactive application and preserves exit code %i",
    async (exitCode) => {
      const output = createIo();
      const loadInteractiveSession = vi.fn(async () => exitCode);

      const result = await runEngineInstallerCli({
        argv: ["install"],
        binaryName: "support-engine",
        io: output.io,
        loadInteractiveSession,
        packageRoot,
      });

      expect(result).toBe(exitCode);
      expect(loadInteractiveSession).toHaveBeenCalledTimes(1);
      expect(output.stdout).toEqual([]);
      expect(output.stderr).toEqual([]);
    },
  );

  it("renders cancellation as exit status 130", async () => {
    const output = createIo();
    const loadInteractiveSession = vi.fn(async () => {
      throw new InstallerError("CANCELLED");
    });

    const result = await runEngineInstallerCli({
      argv: ["uninstall"],
      binaryName: "support-engine",
      io: output.io,
      loadInteractiveSession,
      packageRoot,
    });

    expect(result).toBe(130);
    expect(output.stderr).toEqual(["CANCELLED: Installation was cancelled.\n"]);
  });

  it("renders an operational failure as exit status 1", async () => {
    const output = createIo();
    const loadInteractiveSession = vi.fn(async () => {
      throw new InstallerError("ENGINE_ENTRYPOINT_MISSING");
    });

    const result = await runEngineInstallerCli({
      argv: ["install"],
      binaryName: "support-engine",
      io: output.io,
      loadInteractiveSession,
      packageRoot,
    });

    expect(result).toBe(1);
    expect(output.stderr).toEqual([
      "ENGINE_ENTRYPOINT_MISSING: The Action Engine entry point was not found.\n",
    ]);
  });

  it.each([
    new InstallerError("INSTALLER_INITIALIZATION_FAILED"),
    new TypeError("unexpected"),
  ])(
    "renders an initialization failure as exit status 2: %s",
    async (error) => {
      const output = createIo();
      const loadInteractiveSession = vi.fn(async () => {
        throw error;
      });

      const result = await runEngineInstallerCli({
        argv: ["install"],
        binaryName: "support-engine",
        io: output.io,
        loadInteractiveSession,
        packageRoot,
      });

      expect(result).toBe(2);
      expect(output.stderr).toEqual([
        "INSTALLER_INITIALIZATION_FAILED: The installer could not be initialized.\n",
      ]);
    },
  );
});
