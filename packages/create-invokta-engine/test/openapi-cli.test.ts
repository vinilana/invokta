import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type CreateEngineIo,
  type CreateEngineTerminal,
  type InstallProject,
  runCreateEngineCli,
} from "../src/cli.js";

const fixtureDirectory = fileURLToPath(
  new URL("./fixtures/openapi/", import.meta.url),
);
const discoveryFixture = join(fixtureDirectory, "discovery.yaml");
const minimalFixture = join(fixtureDirectory, "minimal.yaml");
const zeroEligibleFixture = join(
  fixtureDirectory,
  "references/zero-eligible.yaml",
);
const temporaryDirectories: string[] = [];
const encoder = new TextEncoder();

function createWorkingDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "invokta-openapi-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}

function createHarness(): CreateEngineIo & {
  readonly stdout: string[];
  readonly stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    writeStdout(text) {
      stdout.push(text);
    },
    writeStderr(text) {
      stderr.push(text);
    },
  };
}

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

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("create-invokta-engine OpenAPI CLI", () => {
  it("documents the local OpenAPI import and repeatable exclusion syntax", async () => {
    const io = createHarness();

    const exitCode = await runCreateEngineCli({ argv: ["--help"], io });

    expect(exitCode).toBe(0);
    expect(io.stderr).toEqual([]);
    expect(io.stdout.join("")).toContain(
      "[--openapi <local-json-or-yaml-file>]",
    );
    expect(io.stdout.join("")).toContain(
      "[--exclude <operation-id|METHOD:/path>]...",
    );
  });

  it.each([
    [
      "an OpenAPI document with a GitHub example",
      ["my-engine", "--openapi", minimalFixture, "--example", "hello-engine"],
    ],
    [
      "an OpenAPI document with an example path",
      [
        "my-engine",
        "--openapi",
        minimalFixture,
        "--example-path",
        "examples/hello-engine",
      ],
    ],
    ["an exclusion without OpenAPI", ["my-engine", "--exclude", "listWidgets"]],
    [
      "duplicate OpenAPI options",
      ["my-engine", "--openapi", minimalFixture, "--openapi", discoveryFixture],
    ],
    ["a missing OpenAPI value", ["my-engine", "--openapi"]],
    ["a missing exclusion value", ["my-engine", "--exclude"]],
  ] as const)("rejects %s before reading or writing", async (_label, argv) => {
    const cwd = createWorkingDirectory();
    const io = createHarness();
    const terminal = createTerminal([new Error("must not read")]);
    const install = vi.fn<InstallProject>();

    const exitCode = await runCreateEngineCli({
      argv,
      cwd,
      io,
      terminal,
      install,
    });

    expect(exitCode).toBe(2);
    expect(io.stdout).toEqual([]);
    expect(io.stderr).toEqual([
      'Invalid arguments. Run "create-invokta-engine --help".\n',
    ]);
    expect(terminal.readLine).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    expect(existsSync(join(cwd, "my-engine"))).toBe(false);
  });

  it("combines OpenAPI import with a starter profile and retains final confirmation", async () => {
    const cwd = createWorkingDirectory();
    const io = createHarness();
    const terminal = createTerminal([promptLine(""), promptLine("no")]);
    const install = vi.fn<InstallProject>();

    const exitCode = await runCreateEngineCli({
      argv: [
        "my-engine",
        "--profile",
        "cli",
        "--openapi",
        minimalFixture,
        "--no-install",
      ],
      cwd,
      env: {},
      io,
      terminal,
      install,
      loadPackageVersion: async () => "1.2.3",
    });

    expect(exitCode).toBe(0);
    expect(terminal.readLine).toHaveBeenCalledTimes(2);
    expect(io.stderr.join("")).not.toContain("Scaffold profile:");
    expect(io.stderr.join("")).toContain(
      "Exclude operations by number (comma-separated, Enter keeps all): ",
    );
    expect(io.stderr.join("")).toMatch(/1 of 1 .*operation/i);
    expect(io.stderr.join("")).toContain('"my-engine"');
    expect(io.stderr.join("")).toMatch(/CLI/);
    expect(io.stdout).toEqual(["Creation cancelled. No files were created.\n"]);
    expect(existsSync(join(cwd, "my-engine"))).toBe(false);
    expect(install).not.toHaveBeenCalled();
  });

  it.each([
    ["non-terminal execution", false],
    ["--yes in a terminal", true],
  ] as const)(
    "selects every eligible operation by default during %s",
    async (_label, yes) => {
      const cwd = createWorkingDirectory();
      const io = createHarness();
      const terminal = createTerminal([new Error("must not read")], {
        stdinIsTty: yes,
        stderrIsTty: yes,
      });
      const install = vi.fn<InstallProject>();
      const argv = [
        "my-engine",
        "--profile",
        "cli",
        "--openapi",
        minimalFixture,
        "--no-install",
        ...(yes ? ["--yes"] : []),
      ];

      const exitCode = await runCreateEngineCli({
        argv,
        cwd,
        env: {},
        io,
        terminal,
        install,
        loadPackageVersion: async () => "1.2.3",
      });

      expect(exitCode).toBe(0);
      expect(terminal.readLine).not.toHaveBeenCalled();
      expect(io.stderr).toEqual([]);
      expect(io.stdout.join("")).toMatch(/1 capabilit(?:y|ies)/i);
      expect(existsSync(join(cwd, "my-engine"))).toBe(true);
      expect(install).not.toHaveBeenCalled();
    },
  );

  it("shows a deterministic all-selected catalog and applies comma-separated exclusions", async () => {
    const cwd = createWorkingDirectory();
    const io = createHarness();
    const terminal = createTerminal([promptLine("2, 7"), promptLine("no")]);

    const exitCode = await runCreateEngineCli({
      argv: [
        "my-engine",
        "--profile",
        "cli",
        "--openapi",
        discoveryFixture,
        "--no-install",
      ],
      cwd,
      env: {},
      io,
      terminal,
      loadPackageVersion: async () => "1.2.3",
    });

    const output = io.stderr.join("");
    expect(exitCode).toBe(0);
    expect(terminal.readLine).toHaveBeenCalledTimes(2);
    expect(output).toContain(
      "OpenAPI operations (eligible operations are selected by default):",
    );
    expect(output).toMatch(/\[x\]\s+1\.\s+GET:\/alias-a/);
    expect(output).toMatch(/\[x\]\s+2\.\s+GET:\/alias-b/);
    expect(output).toMatch(
      /\[ \]\s+3\.\s+GET:\/bad-parameter.*PARAMETER_UNSUPPORTED/,
    );
    expect(output).toMatch(
      /\[ \]\s+4\.\s+GET:\/no-success.*SUCCESS_RESPONSE_MISSING/,
    );
    expect(output).toMatch(/\[ \]\s+5\.\s+GET:\/oauth.*SECURITY_UNSUPPORTED/);
    expect(output).toMatch(/\[x\]\s+6\.\s+GET:\/operation-server/);
    expect(output).toMatch(/\[x\]\s+7\.\s+GET:\/path-server/);
    expect(output).toMatch(/\[x\]\s+8\.\s+GET:\/root-server/);
    expect(output).toMatch(/\[x\]\s+9\.\s+GET:\/without-operation-id/);
    expect(output).toMatch(
      /\[ \]\s+10\.\s+POST:\/upload.*REQUEST_BODY_UNSUPPORTED/,
    );
    expect(output).toContain(
      "Exclude operations by number (comma-separated, Enter keeps all): ",
    );
    expect(output).toMatch(/4 of 6 .*operation/i);
    expect(output).toMatch(/connection|configuration/i);
    expect(output.indexOf("GET:/alias-a")).toBeLessThan(
      output.indexOf("GET:/alias-b"),
    );
    expect(output.indexOf("GET:/alias-b")).toBeLessThan(
      output.indexOf("GET:/bad-parameter"),
    );
    expect(io.stdout).toEqual(["Creation cancelled. No files were created.\n"]);
    expect(existsSync(join(cwd, "my-engine"))).toBe(false);
  });

  it("accepts repeatable exclusions and resolves operation IDs and canonical selectors", async () => {
    const cwd = createWorkingDirectory();
    const io = createHarness();
    const terminal = createTerminal([new Error("must not read")], {
      stdinIsTty: false,
      stderrIsTty: false,
    });

    const exitCode = await runCreateEngineCli({
      argv: [
        "my-engine",
        "--profile",
        "cli",
        "--openapi",
        discoveryFixture,
        "--exclude",
        "operationServer",
        "--exclude",
        "GET:/path-server",
        "--exclude",
        "operationServer",
        "--no-install",
      ],
      cwd,
      env: {},
      io,
      terminal,
      loadPackageVersion: async () => "1.2.3",
    });

    expect(exitCode).toBe(0);
    expect(terminal.readLine).not.toHaveBeenCalled();
    expect(io.stderr).toEqual([]);
    expect(io.stdout.join("")).toMatch(/4 capabilit(?:y|ies)/i);
    expect(existsSync(join(cwd, "my-engine"))).toBe(true);
  });

  it("rejects invalid interactive exclusions before creating the target", async () => {
    const cwd = createWorkingDirectory();
    const io = createHarness();
    const terminal = createTerminal([
      promptLine("3"),
      promptLine("0"),
      promptLine("1,2,6,7,8,9"),
    ]);
    const install = vi.fn<InstallProject>();

    const exitCode = await runCreateEngineCli({
      argv: [
        "my-engine",
        "--profile",
        "cli",
        "--openapi",
        discoveryFixture,
        "--no-install",
      ],
      cwd,
      env: {},
      io,
      terminal,
      install,
      loadPackageVersion: async () => "1.2.3",
    });

    expect(exitCode).toBe(2);
    expect(terminal.readLine).toHaveBeenCalledTimes(3);
    expect(io.stdout).toEqual([]);
    expect(io.stderr.at(-1)).toBe(
      "PROMPT_INVALID: Interactive input is invalid.\n",
    );
    expect(existsSync(join(cwd, "my-engine"))).toBe(false);
    expect(install).not.toHaveBeenCalled();
  });

  it("rejects an unknown non-interactive exclusion before creating the target", async () => {
    const cwd = createWorkingDirectory();
    const io = createHarness();
    const terminal = createTerminal([new Error("must not read")], {
      stdinIsTty: false,
      stderrIsTty: false,
    });
    const install = vi.fn<InstallProject>();

    const exitCode = await runCreateEngineCli({
      argv: [
        "my-engine",
        "--profile",
        "cli",
        "--openapi",
        minimalFixture,
        "--exclude",
        "GET:/missing",
        "--no-install",
      ],
      cwd,
      env: {},
      io,
      terminal,
      install,
      loadPackageVersion: async () => "1.2.3",
    });

    expect(exitCode).toBe(2);
    expect(terminal.readLine).not.toHaveBeenCalled();
    expect(io.stdout).toEqual([]);
    expect(io.stderr).toEqual([
      "OPENAPI_SELECTION_INVALID: The OpenAPI operation selection is invalid.\n",
    ]);
    expect(existsSync(join(cwd, "my-engine"))).toBe(false);
    expect(install).not.toHaveBeenCalled();
  });

  it("shows the ineligible catalog once and fails without reading in interactive mode", async () => {
    const cwd = createWorkingDirectory();
    const io = createHarness();
    const terminal = createTerminal([new Error("must not read")]);
    const install = vi.fn<InstallProject>();

    const exitCode = await runCreateEngineCli({
      argv: [
        "my-engine",
        "--profile",
        "cli",
        "--openapi",
        zeroEligibleFixture,
        "--no-install",
      ],
      cwd,
      env: {},
      io,
      terminal,
      install,
      loadPackageVersion: async () => "1.2.3",
    });

    const output = io.stderr.join("");
    expect(exitCode).toBe(1);
    expect(output.match(/OpenAPI operations/g)).toHaveLength(1);
    expect(output).toMatch(
      /\[ \]\s+1\.\s+POST:\/upload.*REQUEST_BODY_UNSUPPORTED/,
    );
    expect(output).not.toContain("Exclude operations by number");
    expect(output).not.toMatch(/Create the .* scaffold from OpenAPI/u);
    expect(io.stderr.at(-1)).toBe(
      "OPENAPI_UNSUPPORTED: The OpenAPI document has no supported operation to import.\n",
    );
    expect(terminal.readLine).not.toHaveBeenCalled();
    expect(io.stdout).toEqual([]);
    expect(existsSync(join(cwd, "my-engine"))).toBe(false);
    expect(install).not.toHaveBeenCalled();
  });

  it("fails a non-interactive zero-eligible import without printing the catalog", async () => {
    const cwd = createWorkingDirectory();
    const io = createHarness();
    const terminal = createTerminal([new Error("must not read")], {
      stdinIsTty: false,
      stderrIsTty: false,
    });
    const install = vi.fn<InstallProject>();

    const exitCode = await runCreateEngineCli({
      argv: [
        "my-engine",
        "--profile",
        "cli",
        "--openapi",
        zeroEligibleFixture,
        "--no-install",
      ],
      cwd,
      env: {},
      io,
      terminal,
      install,
      loadPackageVersion: async () => "1.2.3",
    });

    expect(exitCode).toBe(1);
    expect(io.stdout).toEqual([]);
    expect(io.stderr).toEqual([
      "OPENAPI_UNSUPPORTED: The OpenAPI document has no supported operation to import.\n",
    ]);
    expect(terminal.readLine).not.toHaveBeenCalled();
    expect(existsSync(join(cwd, "my-engine"))).toBe(false);
    expect(install).not.toHaveBeenCalled();
  });
});
