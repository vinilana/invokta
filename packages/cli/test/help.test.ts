import { createEngine, defineCapability, type Engine } from "@invokta/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { type CliIo, runCli } from "../src/index.js";

function createIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const readStdin = vi.fn(async () => "");
  const io: CliIo = {
    readStdin,
    writeStdout: (text) => {
      stdout.push(text);
    },
    writeStderr: (text) => {
      stderr.push(text);
    },
  };
  return { io, stdout, stderr, readStdin };
}

const generalHelp = `Usage:
  engine list
  engine describe <capability-id>
  engine run <capability-id> --input '<json>'
  engine run <capability-id> --stdin
  engine run <capability-id> --<flag> <value> ...
  engine run <capability-id> --help
  engine help [<capability-id>]

Commands:
  list      Print capability summaries as JSON.
  describe  Print one capability contract as JSON.
  run       Invoke one capability with exactly one input source.
  help      Print this help, or the flags of one capability.

Run "engine help <capability-id>" to list the flags derived from a
capability's input schema.
`;

const footer = `Flags build one JSON input object that the capability's input schema
validates. Use --input or --stdin for values that flags cannot express.
`;

function createHelpEngine() {
  const wideProperties: Record<string, z.ZodOptional<z.ZodString>> = {};
  for (let index = 0; index < 150; index += 1) {
    wideProperties[`field${String(index).padStart(3, "0")}`] = z
      .string()
      .describe(`Field ${String(index)} ${"x".repeat(1_000)}`)
      .optional();
  }
  return createEngine({
    name: "help-engine",
    version: "0.1.0-test",
    capabilities: {
      "onboarding.create-welcome-message": defineCapability({
        title: "Create a welcome message",
        description: "Creates a short welcome message for a new team member.",
        input: z.object({
          name: z.string().min(1).describe("The new team member's name."),
        }),
        output: z.object({ message: z.string() }),
        access: "public",
        annotations: {
          readOnly: true,
          destructive: false,
          idempotent: true,
          openWorld: false,
        },
        async run({ input }) {
          return { message: `Welcome, ${input.name}!` };
        },
      }),
      "example.flags": defineCapability({
        description: "Echoes the validated flag input.",
        input: z.object({
          ticketId: z.string().describe("Ticket identifier."),
          count: z.number().int().optional(),
          ratio: z.number().optional(),
          dryRun: z.boolean().optional(),
          mode: z.enum(["fast", "slow"]).optional(),
          kind: z.literal("standard").optional(),
          tags: z.array(z.string()).optional(),
          levels: z.array(z.number().int()).optional(),
          toggles: z.array(z.boolean()).optional(),
          priority: z.number().int().default(3),
          nested: z.object({ value: z.string() }),
          union: z.union([z.string(), z.number()]).optional(),
          format: z.string().optional(),
        }),
        output: z.object({ ok: z.boolean() }),
        access: "public",
        async run() {
          return { ok: true };
        },
      }),
      "example.collisions": defineCapability({
        description: "Declares properties whose flag spellings collide.",
        input: z.object({
          ticketId: z.string().optional(),
          ticket_id: z.string().optional(),
          cache: z.boolean().optional(),
          noCache: z.string().optional(),
          "first name": z.string().optional(),
          _private: z.string().optional(),
          help: z.boolean().optional(),
          stdin: z.string().optional(),
          plain: z.string().optional(),
        }),
        output: z.object({ ok: z.boolean() }),
        access: "public",
        async run() {
          return { ok: true };
        },
      }),
      "example.wide": defineCapability({
        title: `Wide \u001b[31mcapability\u001b[0m\nsecond line`,
        description: `Has many properties. ${"d".repeat(2_000)}`,
        input: z.object({
          choice: z.enum(
            Array.from(
              { length: 30 },
              (_, index) => `value${String(index)}`,
            ) as [string, ...string[]],
          ),
          ...wideProperties,
        }),
        output: z.object({ ok: z.boolean() }),
        access: "public",
        async run() {
          return { ok: true };
        },
      }),
    },
  });
}

async function cli(
  argv: readonly string[],
  engine: Engine = createHelpEngine(),
  format?: "json" | "human",
) {
  const invoke = vi.spyOn(engine, "invoke");
  const output = createIo();
  const code = await runCli(engine, {
    argv,
    principal: null,
    io: output.io,
    ...(format === undefined ? {} : { format }),
  });
  return { code, invoke, ...output };
}

describe("CLI help", () => {
  it.each([[["help"]], [["--help"]], [["help", "--help"]]])(
    "prints general usage for %j on stdout with exit code 0",
    async (argv) => {
      const result = await cli(argv);

      expect(result.code).toBe(0);
      expect(result.stdout).toEqual([generalHelp]);
      expect(result.stderr).toEqual([]);
      expect(result.invoke).not.toHaveBeenCalled();
    },
  );

  it.each([[["help", "a", "b"]], [["--help", "list"]], [["help", ""]]])(
    "keeps the invalid-usage exit code for %j",
    async (argv) => {
      const result = await cli(argv);

      expect(result.code).toBe(2);
      expect(result.stdout).toEqual([]);
      expect(JSON.parse(result.stderr.join("")).error).toMatchObject({
        code: "INVALID_USAGE",
        message: expect.stringContaining("Usage:"),
      });
    },
  );

  it("embeds the extended usage in invalid-usage diagnostics", async () => {
    const result = await cli(["unknown"]);

    expect(JSON.parse(result.stderr.join("")).error.message).toBe(
      `Invalid command or arguments.\n\n${generalHelp.split("\n\nCommands:")[0]}`,
    );
  });

  it.each([
    [["help", "onboarding.create-welcome-message"]],
    [["run", "onboarding.create-welcome-message", "--help"]],
  ])("prints the capability page for %j", async (argv) => {
    const result = await cli(argv);

    expect(result.code).toBe(0);
    expect(result.stderr).toEqual([]);
    expect(result.invoke).not.toHaveBeenCalled();
    expect(result.stdout).toEqual([
      `Capability: onboarding.create-welcome-message
Title: Create a welcome message
Description: Creates a short welcome message for a new team member.
Annotations: readOnly=true, destructive=false, idempotent=true, openWorld=false

Usage:
  engine run onboarding.create-welcome-message [flags]
  engine run onboarding.create-welcome-message --input '<json>'
  engine run onboarding.create-welcome-message --stdin

Flags:
  --name <string> (required)
      The new team member's name.

${footer}`,
    ]);
  });

  it("documents types, markers, allowed values, defaults, and input-only properties", async () => {
    const result = await cli(["help", "example.flags"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toEqual([
      `Capability: example.flags
Description: Echoes the validated flag input.

Usage:
  engine run example.flags [flags]
  engine run example.flags --input '<json>'
  engine run example.flags --stdin

Flags:
  --ticket-id <string> (required)
      Ticket identifier.
  --count <integer>
  --ratio <number>
  --dry-run, --no-dry-run
  --mode <string>
      Allowed: fast, slow
  --kind <string>
      Allowed: standard
  --tags <string> (repeatable)
  --levels <integer> (repeatable)
  --toggles, --no-toggles (repeatable)
  --priority <integer>
      Default: 3

Use --input or --stdin for:
  nested (nested object, required)
  union (unsupported schema)
  format (reserved option name)

${footer}`,
    ]);
  });

  it("lists colliding, reserved, and unmappable properties as input-only", async () => {
    const result = await cli(["help", "example.collisions"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toEqual([
      `Capability: example.collisions
Description: Declares properties whose flag spellings collide.

Usage:
  engine run example.collisions [flags]
  engine run example.collisions --input '<json>'
  engine run example.collisions --stdin

Flags:
  --plain <string>

Use --input or --stdin for:
  ticketId (flag name collision)
  ticket_id (flag name collision)
  cache (flag name collision)
  noCache (flag name collision)
  "first name" (no flag spelling)
  _private (no flag spelling)
  help (reserved option name)
  stdin (reserved option name)

${footer}`,
    ]);
  });

  it("bounds and sanitizes the capability page", async () => {
    const result = await cli(["help", "example.wide"]);

    expect(result.code).toBe(0);
    const page = result.stdout.join("");
    const lines = page.split("\n");
    expect(page).not.toContain("\u001b");
    expect(lines).toContain("Title: Wide [31mcapability [0m second line");
    expect(lines.filter((line) => line.startsWith("  --"))).toHaveLength(100);
    expect(lines).toContain("  --field098 <string>");
    expect(lines).not.toContain("  --field099 <string>");
    expect(lines).toContain(
      '  ... and 51 more properties. Run "engine describe example.wide" for the full input schema.',
    );
    expect(lines).toContain(
      "      Allowed: value0, value1, value2, value3, value4, value5, value6, value7, value8, value9, value10, value11, value12, value13, value14, value15, value16, value17, value18, value19, and 10 more",
    );
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(520);
    const description = lines.find((line) => line.startsWith("Description:"));
    expect(description).toBe(
      `Description: Has many properties. ${"d".repeat(479)}...`,
    );
  });

  it("renders a capability without flags and strips bidirectional controls", async () => {
    const engine = createEngine({
      name: "empty-engine",
      version: "0.1.0-test",
      capabilities: {
        "example.empty": defineCapability({
          description: "Takes \u061c\u202eno\u2066 \u200binput.\u200f\u{e0041}",
          input: z.object({}),
          output: z.object({ ok: z.boolean() }),
          access: "public",
          annotations: { readOnly: true },
          async run() {
            return { ok: true };
          },
        }),
      },
    });

    const result = await cli(["help", "example.empty"], engine);

    expect(result.code).toBe(0);
    expect(result.stdout).toEqual([
      `Capability: example.empty
Description: Takes no input.
Annotations: readOnly=true

Usage:
  engine run example.empty --input '<json>'
  engine run example.empty --stdin

Flags:
  (none)

${footer}`,
    ]);
  });

  it("renders help as text regardless of the configured output format", async () => {
    const json = await cli(["help", "example.flags"]);
    const human = await cli(["help", "example.flags"], undefined, "human");

    expect(human.code).toBe(0);
    expect(human.stdout).toEqual(json.stdout);
  });

  it.each([
    [["help", "missing.capability"]],
    [["run", "missing.capability", "--help"]],
  ])("reports an unknown capability for %j", async (argv) => {
    const result = await cli(argv);

    expect(result.code).toBe(1);
    expect(result.stdout).toEqual([]);
    expect(JSON.parse(result.stderr.join(""))).toEqual({
      error: {
        code: "CAPABILITY_NOT_FOUND",
        message: "Capability not found.",
        publicDetails: { capabilityId: "missing.capability" },
      },
    });
  });
});
