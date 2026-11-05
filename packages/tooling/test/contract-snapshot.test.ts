import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { Engine } from "@invokta/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createContractSnapshot,
  runContractCommand,
  serializeContractSnapshot,
} from "../src/index.js";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const commandPath = "packages/tooling/dist/cli.js";
const fixtureDirectory = "packages/tooling/test/fixtures";
const temporaryDirectory = mkdtempSync(join(tmpdir(), "invokta-contract-"));

function fixture(name: string): string {
  return `${fixtureDirectory}/${name}`;
}

async function importEngines(
  name: string,
): Promise<Readonly<Record<string, Engine>>> {
  const specifier = pathToFileURL(join(repositoryRoot, fixture(name))).href;
  return (await import(specifier)) as Readonly<Record<string, Engine>>;
}

let engine: Engine;
let reorderedEngine: Engine;
let forward: Engine;
let reverse: Engine;

function runCommand(...args: readonly string[]) {
  const result = spawnSync(process.execPath, [commandPath, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (result.error !== undefined) throw result.error;
  return result;
}

async function runContract(...args: readonly string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runContractCommand({
    argv: args,
    cwd: repositoryRoot,
    io: {
      writeStdout: (text) => {
        stdout.push(text);
      },
      writeStderr: (text) => {
        stderr.push(text);
      },
    },
  });
  return { exitCode, stdout: stdout.join(""), stderr: stderr.join("") };
}

beforeAll(async () => {
  execFileSync(
    process.execPath,
    [
      "node_modules/typescript/bin/tsc",
      "-b",
      "packages/core",
      "packages/mcp",
      "packages/tooling",
      "--pretty",
      "false",
    ],
    { cwd: repositoryRoot, stdio: "pipe" },
  );
  const contractEngines = await importEngines("contract-engine.js");
  const keyOrderEngines = await importEngines("contract-key-order.js");
  engine = contractEngines.engine as Engine;
  reorderedEngine = contractEngines.reorderedEngine as Engine;
  forward = keyOrderEngines.forward as Engine;
  reverse = keyOrderEngines.reverse as Engine;
});

afterAll(() => {
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe("contract snapshots", () => {
  it("captures the engine's public contract", () => {
    const snapshot = createContractSnapshot(engine);

    expect(snapshot).toEqual({
      formatVersion: 1,
      engine: { name: "contract-engine", version: "2.0.0" },
      capabilities: {
        "support.classify": {
          title: "Classify ticket",
          description: "Classifies a support ticket.",
          access: "authenticated",
          timeoutMs: 5_000,
          annotations: { idempotent: true, readOnly: true },
          deprecated: {
            reason: "Superseded by the triage flow.",
            replacement: "support.triage",
            since: "2.0.0",
          },
          inputSchema: engine.describe("support.classify").inputSchema,
          outputSchema: engine.describe("support.classify").outputSchema,
        },
        "support.triage": {
          description: "Routes a support ticket to a queue.",
          access: "function",
          inputSchema: engine.describe("support.triage").inputSchema,
          outputSchema: engine.describe("support.triage").outputSchema,
        },
      },
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.capabilities["support.classify"])).toBe(
      true,
    );
  });

  it("serializes byte-identical JSON regardless of declaration order", () => {
    const first = serializeContractSnapshot(createContractSnapshot(engine));

    expect(serializeContractSnapshot(createContractSnapshot(engine))).toBe(
      first,
    );
    expect(
      serializeContractSnapshot(createContractSnapshot(reorderedEngine)),
    ).toBe(first);
    expect(first.endsWith("}\n")).toBe(true);
    expect(Object.keys(JSON.parse(first).capabilities)).toEqual([
      "support.classify",
      "support.triage",
    ]);
  });

  it("sorts JSON Schema keywords so key order cannot change the bytes", () => {
    const forwardBytes = serializeContractSnapshot(
      createContractSnapshot(forward),
    );

    expect(serializeContractSnapshot(createContractSnapshot(reverse))).toBe(
      forwardBytes,
    );
    expect(forwardBytes).toContain(
      '"properties": {\n          "count": {\n            "minimum": 0,\n            "type": "integer"\n          },',
    );
  });

  it("rejects an engine whose descriptions do not publish an access kind", async () => {
    const result = await runContract(
      "contract",
      "snapshot",
      fixture("contract-legacy-engine.js"),
    );

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(
      result.stderr,
    ).toBe(`invokta: the engine contract could not be captured.
module: "${fixture("contract-legacy-engine.js")}"
export: "engine"
reason: capability "legacy.read" does not describe a supported access kind.
`);
  });
});

describe("invokta contract snapshot", () => {
  it("writes the snapshot to stdout through the binary", () => {
    const result = runCommand(
      "contract",
      "snapshot",
      fixture("contract-engine.js"),
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      serializeContractSnapshot(createContractSnapshot(engine)),
    );
  });

  it("writes the snapshot to --output and nothing to stdout", async () => {
    const output = join(temporaryDirectory, "contract.json");

    const result = await runContract(
      "contract",
      "snapshot",
      fixture("contract-engine.js"),
      "--export",
      "reorderedEngine",
      "--output",
      output,
    );

    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(readFileSync(output, "utf8")).toBe(
      serializeContractSnapshot(createContractSnapshot(engine)),
    );
  });

  it("reports an unwritable output file", async () => {
    const output = join(temporaryDirectory, "missing", "contract.json");

    const result = await runContract(
      "contract",
      "snapshot",
      fixture("contract-engine.js"),
      "--output",
      output,
    );

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "invokta: the contract snapshot could not be written.",
    );
  });

  it.each([
    [["contract"], "A contract command is required."],
    [["contract", "publish"], 'Unknown contract command "publish".'],
    [["contract", "snapshot"], "A module path is required."],
    [
      ["contract", "snapshot", "a.js", "b.js"],
      "Exactly one module path is required.",
    ],
    [
      ["contract", "snapshot", "a.js", "--export"],
      "The --export option requires a name.",
    ],
    [
      ["contract", "snapshot", "a.js", "--output", "a.json", "--output", "b"],
      "The --output option must be provided at most once.",
    ],
    [
      ["contract", "snapshot", "a.js", "--fail-on-potentially-breaking"],
      'Unknown option "--fail-on-potentially-breaking".',
    ],
  ])("rejects invalid usage %j", async (argv, message) => {
    const result = await runContract(...argv);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`invokta: ${message}`);
    expect(result.stderr).toContain(
      "invokta contract snapshot <esm-module> [--export <name>] [--output <file>]",
    );
  });

  it("contains module failures without echoing their messages", async () => {
    const result = await runContract(
      "contract",
      "snapshot",
      fixture("load-failure.js"),
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("the module could not be loaded");
    expect(result.stderr).not.toContain("Fixture module evaluation failed");
  });

  it("rejects a missing export and a value that is not an engine", async () => {
    const missing = await runContract(
      "contract",
      "snapshot",
      fixture("contract-engine.js"),
      "--export",
      "missingEngine",
    );
    const notEngine = await runContract(
      "contract",
      "snapshot",
      fixture("valid-composition.js"),
      "--export",
      "capabilities",
    );

    expect(missing.exitCode).toBe(2);
    expect(missing.stderr).toContain(
      "the module does not provide the requested export",
    );
    expect(notEngine.exitCode).toBe(2);
    expect(notEngine.stderr).toContain(
      "the selected export is not a usable Invokta engine",
    );
  });
});
