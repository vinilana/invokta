import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createEngine, defineCapability, type Engine } from "@invokta/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createContractSnapshot,
  diffContractSnapshots,
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
          inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
              ticketId: { type: "string", minLength: 1 },
              // Enum membership is canonicalized; declaration order was low, high.
              priority: { type: "string", enum: ["high", "low"] },
            },
            required: ["ticketId"],
          },
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

  it("sorts set-valued required, type, and enum arrays but keeps data arrays", () => {
    const shapes = [
      {
        b: z.string(),
        a: z.union([z.string(), z.number()]),
        k: z.enum(["y", "x"]),
        d: z.array(z.string()).default(["b", "a"]),
      },
      {
        a: z.union([z.number(), z.string()]),
        k: z.enum(["x", "y"]),
        d: z.array(z.string()).default(["b", "a"]),
        b: z.string(),
      },
    ];
    const [first, second] = shapes.map((shape) =>
      serializeContractSnapshot(
        createContractSnapshot(
          createEngine({
            name: "order-engine",
            version: "1.0.0",
            capabilities: {
              "orders.read": defineCapability({
                description: "Reads an order.",
                input: z.object(shape),
                output: z.object({ ok: z.boolean() }),
                access: "public",
                async run() {
                  return { ok: true };
                },
              }),
            },
          }),
        ),
      ),
    );

    expect(second).toBe(first);
    const input = JSON.parse(first as string).capabilities["orders.read"]
      .inputSchema;
    expect(input.required).toEqual(["a", "b", "k"]);
    expect(input.properties.a.type).toEqual(["number", "string"]);
    expect(input.properties.k.enum).toEqual(["x", "y"]);
    expect(input.properties.d.default).toEqual(["b", "a"]);
  });

  it("keeps const values and schemas named like data keywords intact", () => {
    const document = {
      type: "object",
      properties: {
        enum: { type: "object", required: ["z", "a"] },
        mode: { const: ["b", "a"] },
      },
      required: ["mode", "enum"],
      examples: [{ required: ["b", "a"] }],
    };
    const snapshot = createContractSnapshot(
      createEngine({
        name: "data-engine",
        version: "1.0.0",
        capabilities: {
          echo: {
            description: "Returns its input.",
            input: {
              "~standard": {
                version: 1,
                vendor: "invokta-tooling-test",
                validate: (value: unknown) => ({ value }),
                jsonSchema: { input: () => document, output: () => document },
              },
            },
            output: {
              "~standard": {
                version: 1,
                vendor: "invokta-tooling-test",
                validate: (value: unknown) => ({ value }),
                jsonSchema: { input: () => document, output: () => document },
              },
            },
            access: "public",
            async run({ input }) {
              return input as Record<string, unknown>;
            },
          },
        },
      }),
    );

    expect(snapshot.capabilities.echo?.inputSchema).toEqual({
      type: "object",
      properties: {
        enum: { type: "object", required: ["a", "z"] },
        mode: { const: ["b", "a"] },
      },
      required: ["enum", "mode"],
      examples: [{ required: ["b", "a"] }],
    });
  });

  it("serializes integer-like keys first in ascending numeric order", () => {
    const snapshot = createContractSnapshot(
      createEngine({
        name: "key-engine",
        version: "1.0.0",
        capabilities: {
          b: defineCapability({
            description: "B.",
            input: z.object({
              "10": z.string(),
              a: z.string(),
              "9": z.string(),
            }),
            output: z.object({}),
            access: "public",
            async run() {
              return {};
            },
          }),
          "10": defineCapability({
            description: "Ten.",
            input: z.object({}),
            output: z.object({}),
            access: "public",
            async run() {
              return {};
            },
          }),
        },
      }),
    );
    const parsed = JSON.parse(serializeContractSnapshot(snapshot));

    expect(Object.keys(parsed.capabilities)).toEqual(["10", "b"]);
    expect(Object.keys(parsed.capabilities.b.inputSchema.properties)).toEqual([
      "9",
      "10",
      "a",
    ]);
  });

  it("captures declared domain errors keyed by code", () => {
    const declarations = [
      [
        "SLOT_TAKEN",
        {
          description: "The slot is taken.",
          retryable: true,
          details: z.object({ until: z.string(), slotId: z.string() }),
        },
      ],
      ["BOOKING_CLOSED", { description: "Booking is closed." }],
    ] as const;
    const engineWith = (order: readonly (typeof declarations)[number][]) =>
      createEngine({
        name: "booking-engine",
        version: "1.0.0",
        capabilities: {
          "booking.reserve": defineCapability({
            description: "Reserves a slot.",
            input: z.object({ slotId: z.string() }),
            output: z.object({ ok: z.boolean() }),
            access: "public",
            errors: Object.fromEntries(order),
            async run() {
              return { ok: true };
            },
          }),
        },
      });
    const forwardEngine = engineWith(declarations);
    const reverseEngine = engineWith([...declarations].reverse());

    const snapshot = createContractSnapshot(forwardEngine);

    expect(snapshot.capabilities["booking.reserve"]?.errors).toEqual({
      BOOKING_CLOSED: { description: "Booking is closed.", retryable: false },
      SLOT_TAKEN: {
        description: "The slot is taken.",
        retryable: true,
        detailsSchema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          additionalProperties: false,
          properties: {
            slotId: { type: "string" },
            until: { type: "string" },
          },
          required: ["slotId", "until"],
          type: "object",
        },
      },
    });
    expect(
      Object.keys(snapshot.capabilities["booking.reserve"]?.errors ?? {}),
    ).toEqual(["BOOKING_CLOSED", "SLOT_TAKEN"]);
    expect(
      serializeContractSnapshot(createContractSnapshot(reverseEngine)),
    ).toBe(serializeContractSnapshot(snapshot));
    expect(
      Object.hasOwn(
        createContractSnapshot(engine).capabilities["support.triage"] ?? {},
        "errors",
      ),
    ).toBe(false);
  });

  it("captures a capability whose ID is __proto__", () => {
    const capabilities = Object.defineProperty({}, "__proto__", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: defineCapability({
        description: "Has an unusual ID.",
        input: z.object({}),
        output: z.object({}),
        access: "public",
        async run() {
          return {};
        },
      }),
    });
    const protoEngine = createEngine({
      name: "proto-engine",
      version: "1.0.0",
      capabilities,
    });

    const snapshot = createContractSnapshot(protoEngine);
    const serialized = serializeContractSnapshot(snapshot);

    expect(Object.keys(snapshot.capabilities)).toEqual(["__proto__"]);
    expect(Object.hasOwn(snapshot.capabilities, "__proto__")).toBe(true);
    const parsed = JSON.parse(serialized).capabilities;
    expect(
      Object.getOwnPropertyDescriptor(parsed, "__proto__")?.value.description,
    ).toBe("Has an unusual ID.");
    expect(diffContractSnapshots(snapshot, JSON.parse(serialized))).toEqual({
      changes: [],
      breaking: 0,
      potentiallyBreaking: 0,
      compatible: 0,
    });
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
