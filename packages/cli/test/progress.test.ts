import {
  createEngine,
  defineCapability,
  type ProgressReport,
} from "@invokta/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { type CliIo, runCli } from "../src/index.js";

function createProgressEngine(reports: ReadonlyArray<ProgressReport>) {
  return createEngine({
    name: "cli-progress-engine",
    version: "0.1.0-test",
    capabilities: {
      "media.render": defineCapability({
        description: "Reports progress while rendering.",
        input: z.object({}),
        output: z.object({ rendered: z.boolean() }),
        access: "public",
        async run({ context }) {
          for (const report of reports) context.reportProgress(report);
          return { rendered: true };
        },
      }),
    },
  });
}

function createIo(overrides: Partial<CliIo> = {}) {
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
    ...overrides,
  };
  return { io, stdout, stderr };
}

const argv = ["run", "media.render", "--input", "{}"];

describe("CLI progress", () => {
  it("does not observe progress in the default JSON format", async () => {
    const engine = createProgressEngine([
      { progress: 1, total: 2, message: "Halfway." },
    ]);
    const invoke = vi.spyOn(engine, "invoke");
    const output = createIo();

    const code = await runCli(engine, {
      argv,
      principal: null,
      io: output.io,
    });

    expect(code).toBe(0);
    expect(invoke.mock.calls[0]?.[2]).not.toHaveProperty("onProgress");
    expect(output.stdout).toEqual(['{"rendered":true}\n']);
    expect(output.stderr).toEqual([]);
  });

  it("writes concise progress lines to stderr only in the human format", async () => {
    const engine = createProgressEngine([
      { progress: 1, total: 4, message: "Rendering frame 1." },
      { progress: 2.5 },
      { progress: 4, total: 4, message: "" },
    ]);
    const output = createIo();

    const code = await runCli(engine, {
      argv,
      principal: null,
      format: "human",
      io: output.io,
    });

    expect(code).toBe(0);
    expect(output.stderr).toEqual([
      "progress 1/4: Rendering frame 1.\n",
      "progress 2.5\n",
      "progress 4/4\n",
    ]);
    expect(output.stdout).toEqual(['{\n  "rendered": true\n}\n']);
  });

  it("escapes terminal-active characters in progress messages", async () => {
    const engine = createProgressEngine([
      {
        progress: 1,
        message: "a\u001b[31mb\nc d‮e​f\u{e0001}g",
      },
    ]);
    const output = createIo();

    await runCli(engine, {
      argv,
      principal: null,
      format: "human",
      io: output.io,
    });

    expect(output.stderr).toEqual([
      "progress 1: a\\u001b[31mb\\u000ac\\u2028d\\u202ee\\u200bf\\u{e0001}g\n",
    ]);
  });

  it("contains failing and pending progress writes without changing the result", async () => {
    for (const writeStderr of [
      () => {
        throw new Error("stderr unavailable");
      },
      () => Promise.reject(new Error("stderr unavailable")),
      () => new Promise<void>(() => undefined),
    ]) {
      const engine = createProgressEngine([{ progress: 1 }]);
      const output = createIo({ writeStderr });

      await expect(
        runCli(engine, {
          argv,
          principal: null,
          format: "human",
          io: output.io,
        }),
      ).resolves.toBe(0);
      expect(output.stdout).toEqual(['{\n  "rendered": true\n}\n']);
    }
  });
});
