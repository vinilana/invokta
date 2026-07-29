import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { checkCapabilities } from "../src/check-capabilities.js";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const commandPath = "packages/tooling/dist/cli.js";
const commandFile = join(repositoryRoot, commandPath);
const fixtureDirectory = "packages/tooling/test/fixtures";
const fixtureSecret = "fixture-secret-payload-marker";

interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runCommand(...args: readonly string[]): CommandResult {
  const result = spawnSync(process.execPath, [commandPath, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (result.error !== undefined) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function fixture(name: string): string {
  return `${fixtureDirectory}/${name}`;
}

function runCheck(...args: readonly string[]) {
  const stderr: string[] = [];
  return {
    stderr,
    exitCode: checkCapabilities({
      argv: args,
      cwd: repositoryRoot,
      io: {
        writeStderr: (text) => {
          stderr.push(text);
        },
      },
    }),
  };
}

const collidingDiagnostics = `invokta: the capability composition is invalid.
module: "${fixture("colliding-composition.js")}"
export: "capabilities"
issues: 6
issue: code="CAPABILITY_ID_COLLISION" effectiveId="app.classify" declarations=2
  declaration: kind="local" localId="app.classify"
  declaration: kind="library" libraryName="@community/tickets" libraryVersion="3.0.0" defaultId="tickets.classify"
issue: code="CAPABILITY_ID_COLLISION" effectiveId="app.health" declarations=2
  declaration: kind="local" localId="app.health"
  declaration: kind="atomic" sourceName="@community/probes" defaultId="probe.health"
issue: code="CAPABILITY_ID_COLLISION" effectiveId="support.summarize" declarations=2
  declaration: kind="atomic" sourceName="@community/support-capabilities" sourceVersion="2.1.0" defaultId="support.summarize"
  declaration: kind="atomic" sourceName="@community/support-capabilities" sourceVersion="2.1.0" defaultId="support.summarize"
issue: code="CAPABILITY_IMPORT_INVALID" importKind="atomic" reason="EXPORTED_CAPABILITY_REQUIRED"
issue: code="CAPABILITY_IMPORT_ID_NOT_FOUND" libraryName="@community/tickets" defaultId="tickets.unknown"
issue: code="CAPABILITY_REMAP_NOT_SELECTED" libraryName="@community/tickets" defaultId="tickets.summarize"
`;

beforeAll(() => {
  execFileSync(
    process.execPath,
    [
      "node_modules/typescript/bin/tsc",
      "-b",
      "packages/core",
      "packages/tooling",
      "--pretty",
      "false",
    ],
    { cwd: repositoryRoot, stdio: "pipe" },
  );
});

describe("invokta check-capabilities", () => {
  it("exits 0 without any output for a tracked valid composition", () => {
    const result = runCommand(
      "check-capabilities",
      fixture("valid-composition.js"),
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("exits 1 and reports every composition issue in one run", () => {
    const result = runCommand(
      "check-capabilities",
      fixture("colliding-composition.js"),
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(collidingDiagnostics);
  });

  it("renders collisions in a deterministic order across repeated runs", () => {
    const first = runCommand(
      "check-capabilities",
      fixture("colliding-composition.js"),
    );
    const second = runCommand(
      "check-capabilities",
      fixture("colliding-composition.js"),
    );

    expect(first.stderr).toBe(second.stderr);
    expect(
      [...first.stderr.matchAll(/effectiveId="([^"]+)"/g)].map(
        (match) => match[1],
      ),
    ).toEqual(["app.classify", "app.health", "support.summarize"]);
  });

  it("keeps composition diagnostics free of capability payloads", () => {
    const result = runCommand(
      "check-capabilities",
      fixture("colliding-composition.js"),
    );

    for (const payloadMarker of [
      fixtureSecret,
      "~standard",
      "dependencies",
      "apiKey",
      "Fixture capability",
    ]) {
      expect(result.stderr).not.toContain(payloadMarker);
    }
  });

  it("rejects an untracked pre-flattened map instead of claiming collision safety", () => {
    const result = runCommand(
      "check-capabilities",
      fixture("untracked-spread.js"),
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "the selected export is not a tracked capability composition",
    );
    expect(result.stderr).toContain("composeCapabilities");
    expect(result.stderr).toContain("object spread");
    expect(result.stderr).not.toContain("CAPABILITY_ID_COLLISION");
  });

  it("selects a non-default export name with --export", () => {
    const result = runCommand(
      "check-capabilities",
      fixture("named-export.js"),
      "--export",
      "engineCapabilities",
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("exits 2 when the module does not provide the requested export", () => {
    const result = runCommand("check-capabilities", fixture("named-export.js"));

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "the module does not provide the requested export",
    );
    expect(result.stderr).toContain('export: "capabilities"');
  });

  it("exits 2 when application code throws while the module is evaluated", () => {
    const result = runCommand("check-capabilities", fixture("load-failure.js"));

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("the module could not be loaded");
    expect(result.stderr).toContain(
      'error: name="Error" message="Fixture module evaluation failed."',
    );
  });

  it("exits 2 when the module path does not resolve", () => {
    const result = runCommand("check-capabilities", fixture("missing-file.js"));

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("the module could not be loaded");
    expect(result.stderr).toContain('code="ERR_MODULE_NOT_FOUND"');
  });

  it("keeps stdout empty on every documented exit path", () => {
    const invocations: readonly (readonly string[])[] = [
      ["check-capabilities", fixture("valid-composition.js")],
      ["check-capabilities", fixture("colliding-composition.js")],
      ["check-capabilities", fixture("untracked-spread.js")],
      ["check-capabilities", fixture("named-export.js")],
      ["check-capabilities", fixture("load-failure.js")],
      ["check-capabilities", fixture("missing-file.js")],
      [],
      ["check-capabilities"],
      ["check-capabilities", fixture("valid-composition.js"), "--verbose"],
    ];

    for (const argv of invocations) {
      const result = runCommand(...argv);
      expect(result.stdout, `stdout for ${JSON.stringify(argv)}`).toBe("");
    }
  });

  it("runs as a standalone executable through its node shebang", () => {
    expect(readFileSync(commandFile, "utf8").split("\n")[0]).toBe(
      "#!/usr/bin/env node",
    );
    chmodSync(commandFile, 0o755);

    const result = spawnSync(
      commandFile,
      ["check-capabilities", fixture("colliding-composition.js")],
      { cwd: repositoryRoot, encoding: "utf8", shell: false },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(collidingDiagnostics);
  });
});

describe("checkCapabilities usage errors", () => {
  it("rejects a missing command", async () => {
    const run = runCheck();

    await expect(run.exitCode).resolves.toBe(2);
    expect(run.stderr.join("")).toContain("A command is required.");
    expect(run.stderr.join("")).toContain(
      "invokta check-capabilities <esm-module> [--export <name>]",
    );
  });

  it("rejects an unknown command", async () => {
    const run = runCheck("check-composition", fixture("valid-composition.js"));

    await expect(run.exitCode).resolves.toBe(2);
    expect(run.stderr.join("")).toContain(
      'Unknown command "check-composition"',
    );
  });

  it("rejects a missing module path", async () => {
    const run = runCheck("check-capabilities");

    await expect(run.exitCode).resolves.toBe(2);
    expect(run.stderr.join("")).toContain("A module path is required.");
  });

  it("rejects an empty module path", async () => {
    const run = runCheck("check-capabilities", "");

    await expect(run.exitCode).resolves.toBe(2);
    expect(run.stderr.join("")).toContain("The module path must not be empty.");
  });

  it("rejects a second module path", async () => {
    const run = runCheck(
      "check-capabilities",
      fixture("valid-composition.js"),
      fixture("named-export.js"),
    );

    await expect(run.exitCode).resolves.toBe(2);
    expect(run.stderr.join("")).toContain(
      "Exactly one module path is required.",
    );
  });

  it("rejects an unknown flag", async () => {
    const run = runCheck(
      "check-capabilities",
      fixture("valid-composition.js"),
      "--verbose",
    );

    await expect(run.exitCode).resolves.toBe(2);
    expect(run.stderr.join("")).toContain('Unknown option "--verbose"');
  });

  it("rejects --export without a value", async () => {
    const run = runCheck(
      "check-capabilities",
      fixture("valid-composition.js"),
      "--export",
    );

    await expect(run.exitCode).resolves.toBe(2);
    expect(run.stderr.join("")).toContain(
      "The --export option requires a name.",
    );
  });

  it("rejects --export followed by another option", async () => {
    const run = runCheck(
      "check-capabilities",
      fixture("valid-composition.js"),
      "--export",
      "--other",
    );

    await expect(run.exitCode).resolves.toBe(2);
    expect(run.stderr.join("")).toContain(
      "The --export option requires a name.",
    );
  });

  it("rejects a repeated --export option", async () => {
    const run = runCheck(
      "check-capabilities",
      fixture("valid-composition.js"),
      "--export",
      "capabilities",
      "--export",
      "engineCapabilities",
    );

    await expect(run.exitCode).resolves.toBe(2);
    expect(run.stderr.join("")).toContain(
      "The --export option must be provided at most once.",
    );
  });

  it("resolves the module path against the provided working directory", async () => {
    const run = runCheck("check-capabilities", fixture("valid-composition.js"));

    await expect(run.exitCode).resolves.toBe(0);
    expect(run.stderr).toEqual([]);
  });
});
