import { createEngine, defineCapability } from "@invokta/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { type CliIo, runCli } from "../src/index.js";

function createDeprecationEngine() {
  return createEngine({
    name: "deprecation-engine",
    version: "2.0.0",
    capabilities: {
      "support.classify": defineCapability({
        description: "Classifies a support ticket.",
        input: z.object({ value: z.string() }),
        output: z.object({ result: z.string() }),
        access: "authenticated",
        deprecated: {
          reason: "Superseded by the triage flow.",
          since: "2.0.0",
          replacement: "support.triage",
        },
        async run({ input }) {
          return { result: input.value };
        },
      }),
    },
  });
}

function createIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    readStdin: async () => "",
    writeStdout: (text) => {
      stdout.push(text);
    },
    writeStderr: (text) => {
      stderr.push(text);
    },
  };
  return { io, stdout, stderr };
}

const deprecated = {
  reason: "Superseded by the triage flow.",
  since: "2.0.0",
  replacement: "support.triage",
};

describe("CLI deprecation output", () => {
  it("shows the deprecation notice in list output", async () => {
    const output = createIo();

    const code = await runCli(createDeprecationEngine(), {
      argv: ["list"],
      principal: null,
      io: output.io,
    });

    expect(code).toBe(0);
    expect(JSON.parse(output.stdout.join(""))).toEqual([
      {
        id: "support.classify",
        description: "Classifies a support ticket.",
        deprecated,
      },
    ]);
    expect(output.stderr).toEqual([]);
  });

  it("shows the deprecation notice and access kind in describe output", async () => {
    const output = createIo();

    const code = await runCli(createDeprecationEngine(), {
      argv: ["describe", "support.classify"],
      principal: null,
      format: "human",
      io: output.io,
    });

    expect(code).toBe(0);
    expect(JSON.parse(output.stdout.join(""))).toMatchObject({
      id: "support.classify",
      deprecated,
      access: "authenticated",
    });
    expect(output.stdout.join("")).toContain(
      '"reason": "Superseded by the triage flow."',
    );
    expect(output.stderr).toEqual([]);
  });

  it("runs a deprecated capability with an unchanged result", async () => {
    const output = createIo();

    const code = await runCli(createDeprecationEngine(), {
      argv: ["run", "support.classify", "--input", '{"value":"same"}'],
      principal: { id: "local:operator" },
      io: output.io,
    });

    expect(code).toBe(0);
    expect(output.stdout).toEqual(['{"result":"same"}\n']);
    expect(output.stderr).toEqual([]);
  });
});
