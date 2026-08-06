import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { doctorReportToJson, inspectEngine } from "../src/doctor.js";
import type { LoadedEngine } from "../src/load-engine.js";
import { runDevtoolsCli } from "../src/run-devtools-cli.js";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const commandPath = "packages/devtools/dist/cli.js";
const commandFile = join(repositoryRoot, commandPath);
const fixtureDirectory = "packages/devtools/test/fixtures";
const fixtureSecret = "devtools-fixture-secret-payload-marker";

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

function runCli(...args: readonly string[]) {
  const stderr: string[] = [];
  return {
    stderr,
    exitCode: runDevtoolsCli({
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

const validEngineReport = `invokta-devtools: the engine passed the doctor checks.
module: "${fixture("valid-engine.js")}"
export: "engine"
engine: name="fixture-engine" version="0.1.0" capabilities=2
notes: 4
note: code="TITLE_MISSING" capabilityId="fixture.echo" hint: Add a title to the capability definition.
note: code="ANNOTATIONS_MISSING" capabilityId="fixture.echo" hint: Add annotations such as { readOnly: true } to the capability definition.
note: code="MCP_MANIFEST_MISSING" hint: Add an invokta.mcp.json manifest next to the project to make the engine installable as an MCP server (scaffolded by create-invokta-engine).
note: code="COMPOSITION_CHECK_AVAILABLE" reason: run "invokta check-capabilities" against the composed export.
`;

beforeAll(() => {
  execFileSync(
    process.execPath,
    [
      "node_modules/typescript/bin/tsc",
      "-b",
      "packages/core",
      "packages/devtools",
      "--pretty",
      "false",
    ],
    { cwd: repositoryRoot, stdio: "pipe" },
  );
});

describe("invokta-devtools doctor", () => {
  it("exits 0 and reports notes for a valid engine", () => {
    const result = runCommand("doctor", fixture("valid-engine.js"));

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(validEngineReport);
  });

  it("renders the report deterministically across repeated runs", () => {
    const first = runCommand("doctor", fixture("valid-engine.js"));
    const second = runCommand("doctor", fixture("valid-engine.js"));

    expect(first.stderr).toBe(second.stderr);
  });

  it("selects a non-default export name with --export", () => {
    const result = runCommand(
      "doctor",
      fixture("named-export.js"),
      "--export",
      "devEngine",
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      'engine: name="named-fixture-engine" version="0.1.0" capabilities=0',
    );
  });

  it("exits 1 when describe fails for a listed capability", () => {
    const result = runCommand("doctor", fixture("broken-describe-engine.js"));

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "invokta-devtools: the engine failed the doctor checks.",
    );
    expect(result.stderr).toContain("findings: 1");
    expect(result.stderr).toContain(
      'finding: code="DESCRIBE_FAILED" capabilityId="fixture.broken" error: name="Error" message="Fixture describe failed."',
    );
  });

  it("exits 1 when a description exposes an unreadable schema", () => {
    const result = runCommand("doctor", fixture("schema-unreadable-engine.js"));

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      'finding: code="SCHEMA_UNREADABLE" capabilityId="fixture.opaque" schema="input"',
    );
    expect(result.stderr).not.toContain('schema="output"');
  });

  it("reports duplicate capability ids as an advisory note", () => {
    const result = runCommand("doctor", fixture("duplicate-id-engine.js"));

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('code="DUPLICATE_CAPABILITY_ID"');
  });

  it("keeps doctor diagnostics free of capability payloads", () => {
    for (const name of [
      "valid-engine.js",
      "broken-describe-engine.js",
      "schema-unreadable-engine.js",
    ]) {
      const result = runCommand("doctor", fixture(name));
      expect(result.stderr, name).not.toContain(fixtureSecret);
      expect(result.stderr, name).not.toContain("~standard");
    }
  });

  it("exits 2 when the export is not an engine", () => {
    const result = runCommand("doctor", fixture("not-an-engine.js"));

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("the selected export is not an engine");
    expect(result.stderr).toContain(
      "reason: an engine provides name, version, invoke, list, and describe.",
    );
  });

  it("exits 2 when the module does not provide the requested export", () => {
    const result = runCommand("doctor", fixture("named-export.js"));

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "the module does not provide the requested export",
    );
    expect(result.stderr).toContain('export: "engine"');
  });

  it("exits 2 when application code throws while the module is evaluated", () => {
    const result = runCommand("doctor", fixture("load-failure.js"));

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("the module could not be loaded");
    expect(result.stderr).toContain(
      'error: name="Error" message="Fixture module evaluation failed."',
    );
  });

  it("exits 2 when the module path does not resolve", () => {
    const result = runCommand("doctor", fixture("missing-file.js"));

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("the module could not be loaded");
    expect(result.stderr).toContain('code="ERR_MODULE_NOT_FOUND"');
  });

  it("keeps stdout empty on every documented exit path", () => {
    const invocations: readonly (readonly string[])[] = [
      ["doctor", fixture("valid-engine.js")],
      ["doctor", fixture("broken-describe-engine.js")],
      ["doctor", fixture("not-an-engine.js")],
      ["doctor", fixture("named-export.js")],
      ["doctor", fixture("load-failure.js")],
      ["doctor", fixture("missing-file.js")],
      ["unknown"],
      ["doctor"],
      ["doctor", fixture("valid-engine.js"), "--verbose"],
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
      ["doctor", fixture("valid-engine.js")],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        shell: false,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(validEngineReport);
  });
});

describe("inspectEngine advisory checks", () => {
  function unitEngine(
    list: LoadedEngine["list"],
    describeCapability: (capabilityId: string) => unknown,
  ): LoadedEngine {
    return {
      name: "unit-engine",
      version: "0.0.1",
      invoke: async () => ({}),
      list,
      describe: describeCapability as LoadedEngine["describe"],
    };
  }

  function fullDescription(
    overrides: Readonly<Record<string, unknown>> = {},
  ): Record<string, unknown> {
    return {
      id: "fixture.op",
      description: "Described.",
      title: "Fixture",
      annotations: { readOnly: true },
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      ...overrides,
    };
  }

  it("notes duplicate capability ids in the list", () => {
    const report = inspectEngine(
      unitEngine(
        () => [
          { id: "fixture.op", description: "One." },
          { id: "fixture.op", description: "Two." },
        ],
        () => fullDescription(),
      ),
    );

    const duplicates = report.notes.filter(
      (note) => note.code === "DUPLICATE_CAPABILITY_ID",
    );
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]).toMatchObject({
      capabilityId: "fixture.op",
      hint: expect.any(String),
    });
    expect(report.findings).toEqual([]);
  });

  it("notes a missing or empty description", () => {
    const report = inspectEngine(
      unitEngine(
        () => [
          { id: "fixture.missing", description: "One." },
          { id: "fixture.empty", description: "Two." },
          { id: "fixture.blank", description: "Three." },
        ],
        (capabilityId) =>
          fullDescription({
            id: capabilityId,
            ...(capabilityId === "fixture.missing"
              ? { description: undefined }
              : capabilityId === "fixture.empty"
                ? { description: "" }
                : { description: "   " }),
          }),
      ),
    );

    expect(
      report.notes
        .filter((note) => note.code === "DESCRIPTION_MISSING")
        .map((note) => ("capabilityId" in note ? note.capabilityId : "")),
    ).toEqual(["fixture.missing", "fixture.empty", "fixture.blank"]);
  });

  it("notes a schema object without a type keyword", () => {
    const report = inspectEngine(
      unitEngine(
        () => [{ id: "fixture.op", description: "One." }],
        () =>
          fullDescription({
            inputSchema: { properties: {} },
            outputSchema: { type: "object" },
          }),
      ),
    );

    expect(report.findings).toEqual([]);
    expect(report.notes).toContainEqual(
      expect.objectContaining({
        code: "SCHEMA_WITHOUT_TYPE",
        capabilityId: "fixture.op",
        schema: "input",
        hint: expect.any(String),
      }),
    );
    expect(
      report.notes.filter((note) => note.code === "SCHEMA_WITHOUT_TYPE"),
    ).toHaveLength(1);
  });

  it("keeps schema-without-type advisory while an unreadable schema stays a finding", () => {
    const report = inspectEngine(
      unitEngine(
        () => [{ id: "fixture.op", description: "One." }],
        () => fullDescription({ inputSchema: null }),
      ),
    );

    expect(report.findings).toContainEqual(
      expect.objectContaining({
        code: "SCHEMA_UNREADABLE",
        capabilityId: "fixture.op",
        schema: "input",
        hint: expect.any(String),
      }),
    );
    expect(
      report.notes.filter((note) => note.code === "SCHEMA_WITHOUT_TYPE"),
    ).toEqual([]);
  });

  it("carries remediation hints into the JSON-safe report body", () => {
    const report = inspectEngine(
      unitEngine(
        () => [{ id: "fixture.op", description: "One." }],
        () => fullDescription({ inputSchema: null }),
      ),
      { mcpManifestPresent: false },
    );

    const body = doctorReportToJson(report) as {
      readonly findings: ReadonlyArray<Readonly<Record<string, unknown>>>;
      readonly notes: ReadonlyArray<Readonly<Record<string, unknown>>>;
    };
    expect(body.findings[0]?.code).toBe("SCHEMA_UNREADABLE");
    expect(typeof body.findings[0]?.hint).toBe("string");
    const manifestNote = body.notes.find(
      (note) => note.code === "MCP_MANIFEST_MISSING",
    );
    expect(typeof manifestNote?.hint).toBe("string");
    expect(JSON.stringify(body)).toContain("invokta.mcp.json");
  });
});

describe("runDevtoolsCli usage errors", () => {
  it("rejects an unknown command", async () => {
    const run = runCli("inspect", fixture("valid-engine.js"));

    await expect(run.exitCode).resolves.toBe(2);
    expect(run.stderr.join("")).toContain('Unknown command "inspect"');
  });

  it("rejects a missing module path", async () => {
    const run = runCli("doctor");

    await expect(run.exitCode).resolves.toBe(2);
    expect(run.stderr.join("")).toContain("A module path is required.");
  });

  it("rejects an empty module path", async () => {
    const run = runCli("doctor", "");

    await expect(run.exitCode).resolves.toBe(2);
    expect(run.stderr.join("")).toContain("The module path must not be empty.");
  });

  it("rejects a second module path", async () => {
    const run = runCli(
      "doctor",
      fixture("valid-engine.js"),
      fixture("named-export.js"),
    );

    await expect(run.exitCode).resolves.toBe(2);
    expect(run.stderr.join("")).toContain(
      "Exactly one module path is required.",
    );
  });

  it("rejects an unknown flag", async () => {
    const run = runCli("doctor", fixture("valid-engine.js"), "--verbose");

    await expect(run.exitCode).resolves.toBe(2);
    expect(run.stderr.join("")).toContain('Unknown option "--verbose"');
  });

  it("rejects --export without a value", async () => {
    const run = runCli("doctor", fixture("valid-engine.js"), "--export");

    await expect(run.exitCode).resolves.toBe(2);
    expect(run.stderr.join("")).toContain(
      "The --export option requires a name.",
    );
  });

  it("rejects a repeated --export option", async () => {
    const run = runCli(
      "doctor",
      fixture("valid-engine.js"),
      "--export",
      "engine",
      "--export",
      "devEngine",
    );

    await expect(run.exitCode).resolves.toBe(2);
    expect(run.stderr.join("")).toContain(
      "The --export option must be provided at most once.",
    );
  });
});
