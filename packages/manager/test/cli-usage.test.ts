import { describe, expect, it, vi } from "vitest";

import {
  helpText,
  invalidUsageText,
  parseManagerArguments,
  runManagerCli,
} from "../src/run-manager-cli.js";

function run(argv: readonly string[], overrides = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    status: runManagerCli({
      argv,
      io: {
        writeStdout: (text) => {
          stdout.push(text);
        },
        writeStderr: (text) => {
          stderr.push(text);
        },
      },
      loadConsole: async () => 0,
      loadPackageVersion: async () => "0.3.0",
      ...overrides,
    }),
  };
}

describe("invokta-manager argument grammar", () => {
  it("accepts the documented vectors", () => {
    expect(parseManagerArguments([])).toEqual({
      kind: "start",
      options: { port: 0, scanRoots: [], open: true },
    });
    expect(parseManagerArguments(["--no-open"])).toMatchObject({
      options: { open: false },
    });
    expect(parseManagerArguments(["--port", "8080"])).toMatchObject({
      options: { port: 8080 },
    });
    expect(
      parseManagerArguments(["--scan", "/a", "--scan", "/b", "--no-open"]),
    ).toMatchObject({ options: { scanRoots: ["/a", "/b"], open: false } });
    expect(parseManagerArguments(["--help"])).toEqual({ kind: "help" });
    expect(parseManagerArguments(["--version"])).toEqual({ kind: "version" });
  });

  it.each([
    ["an unknown option", ["--verbose"]],
    ["a missing port value", ["--port"]],
    ["a non-numeric port", ["--port", "http"]],
    ["a port below the range", ["--port", "0"]],
    ["a port above the range", ["--port", "70000"]],
    ["a repeated port", ["--port", "8080", "--port", "8081"]],
    ["a repeated no-open", ["--no-open", "--no-open"]],
    ["a missing scan value", ["--scan"]],
    ["an option used as a value", ["--scan", "--no-open"]],
    ["help mixed with another option", ["--help", "--no-open"]],
    ["version mixed with another option", ["--version", "--port", "8080"]],
    ["a bare argument", ["start"]],
  ])("rejects %s", (_name, argv) => {
    expect(parseManagerArguments(argv)).toBeUndefined();
  });
});

describe("invokta-manager command line", () => {
  it("prints help and exits successfully", async () => {
    const invocation = run(["--help"]);

    await expect(invocation.status).resolves.toBe(0);
    expect(invocation.stdout.join("")).toBe(helpText);
    expect(invocation.stderr).toEqual([]);
  });

  it("prints the manifest version", async () => {
    const invocation = run(["--version"]);

    await expect(invocation.status).resolves.toBe(0);
    expect(invocation.stdout.join("")).toBe("0.3.0\n");
  });

  it("returns usage status two without loading the console", async () => {
    const loadConsole = vi.fn(async () => 0 as const);
    const invocation = run(["--nope"], { loadConsole });

    await expect(invocation.status).resolves.toBe(2);
    expect(invocation.stderr.join("")).toBe(invalidUsageText);
    expect(loadConsole).not.toHaveBeenCalled();
  });

  it("does not require a terminal", async () => {
    const loadConsole = vi.fn(async () => 0 as const);
    const invocation = run(["--no-open"], { loadConsole });

    await expect(invocation.status).resolves.toBe(0);
    expect(loadConsole).toHaveBeenCalledWith({
      port: 0,
      scanRoots: [],
      open: false,
    });
  });

  it("reports an initialization failure as status two", async () => {
    const invocation = run(["--no-open"], {
      loadConsole: async () => {
        throw new Error("boom");
      },
    });

    await expect(invocation.status).resolves.toBe(2);
    expect(invocation.stderr.join("")).toContain(
      "INSTALLER_INITIALIZATION_FAILED",
    );
    expect(invocation.stderr.join("")).not.toContain("boom");
  });
});
