import { createEngine, defineCapability } from "@invokta/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { type CliIo, runCli } from "../src/index.js";

function createIo(stdin = "") {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const readStdin = vi.fn(async () => stdin);
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

const welcomeCapability = defineCapability({
  title: "Create a welcome message",
  description: "Creates a short welcome message for a new team member.",
  input: z.object({ name: z.string().min(1) }),
  output: z.object({ message: z.string() }),
  access: "public",
  async run({ input }) {
    return { message: `Welcome, ${input.name}!` };
  },
});

const flagsCapability = defineCapability({
  description: "Echoes the validated flag input.",
  input: z.object({
    ticketId: z.string(),
    count: z.number().int().optional(),
    ratio: z.number().optional(),
    dryRun: z.boolean().optional(),
    mode: z.enum(["fast", "slow"]).optional(),
    kind: z.literal("standard").optional(),
    tags: z.array(z.string()).optional(),
    levels: z.array(z.number().int()).optional(),
    toggles: z.array(z.boolean()).optional(),
    priority: z.number().int().default(3),
    nested: z.object({ value: z.string() }).optional(),
    union: z.union([z.string(), z.number()]).optional(),
    format: z.string().optional(),
  }),
  output: z.object({ received: z.record(z.string(), z.unknown()) }),
  access: "public",
  async run({ input }) {
    return { received: input };
  },
});

function createFlagsEngine() {
  return createEngine({
    name: "flags-engine",
    version: "0.1.0-test",
    capabilities: {
      "onboarding.create-welcome-message": welcomeCapability,
      "example.flags": flagsCapability,
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
      "example.secured": defineCapability({
        description: "Rejects anonymous callers.",
        input: z.object({ actor: z.string(), role: z.string() }),
        output: z.object({ result: z.string() }),
        access: "authenticated",
        async run() {
          return { result: "never" };
        },
      }),
    },
  });
}

async function run(argv: readonly string[]) {
  const engine = createFlagsEngine();
  const invoke = vi.spyOn(engine, "invoke");
  const output = createIo();
  const code = await runCli(engine, {
    argv,
    principal: null,
    io: output.io,
  });
  return { code, invoke, ...output };
}

function invokedInput(invoke: {
  readonly mock: { readonly calls: readonly (readonly unknown[])[] };
}): unknown {
  return invoke.mock.calls[0]?.[1];
}

function usageError(stderr: readonly string[]): {
  readonly code: string;
  readonly message: string;
} {
  return (
    JSON.parse(stderr.join("")) as {
      error: { code: string; message: string };
    }
  ).error;
}

describe("schema-derived run flags", () => {
  it("builds the input from a space-separated flag and invokes once", async () => {
    const result = await run([
      "run",
      "onboarding.create-welcome-message",
      "--name",
      "Ada",
    ]);

    expect(result.code).toBe(0);
    expect(result.invoke).toHaveBeenCalledTimes(1);
    expect(result.invoke).toHaveBeenCalledWith(
      "onboarding.create-welcome-message",
      { name: "Ada" },
      { source: "cli", principal: null },
    );
    expect(result.stdout).toEqual(['{"message":"Welcome, Ada!"}\n']);
    expect(result.stderr).toEqual([]);
    expect(result.readStdin).not.toHaveBeenCalled();
  });

  it("accepts the --name=value spelling, including values that start with --", async () => {
    const equals = await run([
      "run",
      "onboarding.create-welcome-message",
      "--name=Ada",
    ]);
    const dashed = await run([
      "run",
      "onboarding.create-welcome-message",
      "--name=--Ada",
    ]);

    expect(equals.code).toBe(0);
    expect(invokedInput(equals.invoke)).toEqual({ name: "Ada" });
    expect(dashed.code).toBe(0);
    expect(invokedInput(dashed.invoke)).toEqual({ name: "--Ada" });
  });

  it("maps property names to kebab-case and coerces only by declared type", async () => {
    const result = await run([
      "run",
      "example.flags",
      "--count",
      "3",
      "--ticket-id",
      "T-1",
      "--ratio",
      "-0.5",
      "--dry-run",
      "--mode",
      "fast",
      "--kind",
      "standard",
    ]);

    expect(result.code).toBe(0);
    const input = invokedInput(result.invoke);
    expect(input).toEqual({
      ticketId: "T-1",
      count: 3,
      ratio: -0.5,
      dryRun: true,
      mode: "fast",
      kind: "standard",
    });
    expect(Object.keys(input as object)).toEqual([
      "ticketId",
      "count",
      "ratio",
      "dryRun",
      "mode",
      "kind",
    ]);
    expect(input).not.toHaveProperty("priority");
    expect(JSON.parse(result.stdout.join(""))).toEqual({
      received: {
        ticketId: "T-1",
        count: 3,
        ratio: -0.5,
        dryRun: true,
        mode: "fast",
        kind: "standard",
        priority: 3,
      },
    });
  });

  it.each([
    [["--no-dry-run"], false],
    [["--dry-run=false"], false],
    [["--dry-run=true"], true],
    [["--dry-run"], true],
  ])("decodes boolean flag %j as %s", async (flags, expected) => {
    const result = await run([
      "run",
      "example.flags",
      "--ticket-id",
      "T-1",
      ...flags,
    ]);

    expect(result.code).toBe(0);
    expect(invokedInput(result.invoke)).toEqual({
      ticketId: "T-1",
      dryRun: expected,
    });
  });

  it("collects repeated array flags in order", async () => {
    const result = await run([
      "run",
      "example.flags",
      "--ticket-id",
      "T-1",
      "--tags",
      "a",
      "--levels=1",
      "--tags=b",
      "--levels",
      "2",
      "--toggles",
      "--no-toggles",
      "--toggles=true",
    ]);

    expect(result.code).toBe(0);
    expect(invokedInput(result.invoke)).toEqual({
      ticketId: "T-1",
      tags: ["a", "b"],
      levels: [1, 2],
      toggles: [true, false, true],
    });
  });

  it("leaves required properties and enum membership to schema validation", async () => {
    const missing = await run(["run", "example.flags", "--count", "2"]);
    const outsideEnum = await run([
      "run",
      "example.flags",
      "--ticket-id",
      "T-1",
      "--mode",
      "medium",
    ]);

    expect(missing.code).toBe(1);
    expect(missing.invoke).toHaveBeenCalledTimes(1);
    expect(invokedInput(missing.invoke)).toEqual({ count: 2 });
    expect(usageError(missing.stderr).code).toBe("INPUT_INVALID");
    expect(outsideEnum.code).toBe(1);
    expect(invokedInput(outsideEnum.invoke)).toEqual({
      ticketId: "T-1",
      mode: "medium",
    });
    expect(usageError(outsideEnum.stderr).code).toBe("INPUT_INVALID");
  });

  it.each([
    [["--count", "1.5"], "--count expects an integer"],
    [["--count", "9007199254740993"], "--count expects an integer"],
    [["--count="], "--count expects an integer"],
    [["--ratio", "abc"], "--ratio expects a number"],
    [["--ratio", "0x10"], "--ratio expects a number"],
    [["--ratio", "1e999"], "--ratio expects a number"],
    [["--ratio", " 1"], "--ratio expects a number"],
    [["--levels", "one"], "--levels expects an integer"],
    [["--dry-run=yes"], "--dry-run expects true or false"],
    [["--no-dry-run=false"], "--no-dry-run does not take a value"],
    [["--ticket-id"], "--ticket-id requires a value"],
    [["--ticket-id", "--count", "1"], "--ticket-id requires a value"],
    [["--ticket-id", "a", "--ticket-id", "b"], "more than once"],
    [["--dry-run", "--no-dry-run"], "more than once"],
  ])(
    "rejects undecodable flag %j as invalid usage before invoke",
    async (flags, message) => {
      const result = await run(["run", "example.flags", ...flags]);

      expect(result.code).toBe(2);
      expect(result.invoke).not.toHaveBeenCalled();
      expect(result.stdout).toEqual([]);
      const error = usageError(result.stderr);
      expect(error.code).toBe("INVALID_USAGE");
      expect(error.message).toContain(message);
    },
  );

  it("rejects unknown flags with usage and never echoes their values", async () => {
    const result = await run([
      "run",
      "example.flags",
      "--ticket-id",
      "T-1",
      "--password=hunter2",
    ]);

    expect(result.code).toBe(2);
    expect(result.invoke).not.toHaveBeenCalled();
    const error = usageError(result.stderr);
    expect(error.code).toBe("INVALID_USAGE");
    expect(error.message).toContain("Unknown flag --password");
    expect(error.message).toContain("engine help example.flags");
    expect(error.message).toContain("Usage:");
    expect(result.stderr.join("")).not.toContain("hunter2");
  });

  it("rejects positional arguments without echoing them", async () => {
    const result = await run([
      "run",
      "example.flags",
      "--dry-run",
      "secret-positional",
    ]);

    expect(result.code).toBe(2);
    expect(result.invoke).not.toHaveBeenCalled();
    expect(usageError(result.stderr).message).toContain("Usage:");
    expect(result.stderr.join("")).not.toContain("secret-positional");
  });

  it.each([
    [["--nested", "x"], "nested"],
    [["--union", "1"], "union"],
    [["--format", "json"], "format"],
  ])(
    "requires --input or --stdin for input-only property %j",
    async (flags, property) => {
      const result = await run([
        "run",
        "example.flags",
        "--ticket-id",
        "T-1",
        ...flags,
      ]);

      expect(result.code).toBe(2);
      expect(result.invoke).not.toHaveBeenCalled();
      const error = usageError(result.stderr);
      expect(error.code).toBe("INVALID_USAGE");
      expect(error.message).toContain(`Property ${property}`);
      expect(error.message).toContain("--input");
      expect(error.message).toContain("--stdin");
    },
  );

  it.each([
    [["--ticket-id", "x"], "ticketId"],
    [["--cache"], "cache"],
    [["--no-cache"], "noCache"],
    [["--first-name", "x"], "first name"],
    [["--no-help"], "help"],
  ])(
    "fails closed for colliding, reserved, or unmappable flag %j",
    async (flags, property) => {
      const result = await run(["run", "example.collisions", ...flags]);

      expect(result.code).toBe(2);
      expect(result.invoke).not.toHaveBeenCalled();
      const error = usageError(result.stderr);
      expect(error.code).toBe("INVALID_USAGE");
      expect(error.message).toContain("--input");
      if (property !== "first name") expect(error.message).toContain(property);
    },
  );

  it("keeps non-colliding properties addressable next to collisions", async () => {
    const result = await run(["run", "example.collisions", "--plain", "x"]);

    expect(result.code).toBe(0);
    expect(invokedInput(result.invoke)).toEqual({ plain: "x" });
  });

  it.each([
    [["--name", "Ada", "--input", '{"name":"Ada"}']],
    [["--input", '{"name":"Ada"}', "--name", "Ada"]],
    [["--stdin", "--name", "Ada"]],
    [["--name", "Ada", "--stdin"]],
    [["--input={}"]],
    [["--stdin=true"]],
    [["--name", "Ada", "--help"]],
    [["--help=true"]],
  ])(
    "rejects combining flags with another input source or help: %j",
    async (flags) => {
      const result = await run([
        "run",
        "onboarding.create-welcome-message",
        ...flags,
      ]);

      expect(result.code).toBe(2);
      expect(result.invoke).not.toHaveBeenCalled();
      expect(result.readStdin).not.toHaveBeenCalled();
      expect(result.stdout).toEqual([]);
      expect(usageError(result.stderr)).toMatchObject({
        code: "INVALID_USAGE",
        message: expect.stringContaining("Usage:"),
      });
    },
  );

  it("reports an unknown capability through its public description error", async () => {
    const result = await run(["run", "missing.capability", "--name", "Ada"]);

    expect(result.code).toBe(1);
    expect(result.invoke).not.toHaveBeenCalled();
    expect(JSON.parse(result.stderr.join(""))).toEqual({
      error: {
        code: "CAPABILITY_NOT_FOUND",
        message: "Capability not found.",
        publicDetails: { capabilityId: "missing.capability" },
      },
    });
  });

  it("treats identity-like property flags as business input only", async () => {
    const result = await run([
      "run",
      "example.secured",
      "--actor",
      "admin",
      "--role",
      "admin",
    ]);

    expect(result.code).toBe(1);
    expect(result.invoke).toHaveBeenCalledWith(
      "example.secured",
      { actor: "admin", role: "admin" },
      { source: "cli", principal: null },
    );
    expect(JSON.parse(result.stderr.join(""))).toEqual({
      error: {
        code: "UNAUTHENTICATED",
        message: "Authentication is required.",
      },
    });
  });
});
