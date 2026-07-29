import { createEngine, defineCapability, EngineError } from "@invokta/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { type CliIo, runCli } from "../src/index.js";
import { readUtf8 } from "../src/stdin.js";

interface RunObserverArgs {
  readonly input: { readonly value: string };
  readonly context: {
    readonly source: string;
    readonly principal: { readonly id: string } | null;
    readonly signal: AbortSignal;
  };
}

function createTestEngine(options?: {
  readonly access?: "public" | "authenticated";
  readonly run?: (
    args: RunObserverArgs,
  ) => Promise<{ readonly result: string }>;
}) {
  return createEngine({
    name: "test-engine",
    version: "0.1.0-test",
    capabilities: {
      "example.echo": defineCapability({
        title: "Echo",
        description: "Returns the provided value.",
        input: z.object({ value: z.string() }),
        output: z.object({ result: z.string() }),
        access: options?.access ?? "public",
        annotations: { readOnly: true, idempotent: true },
        async run(args) {
          return (
            options?.run?.({
              input: args.input,
              context: args.context,
            }) ?? Promise.resolve({ result: args.input.value })
          );
        },
      }),
    },
  });
}

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

describe("runCli", () => {
  it("lists capabilities as canonical JSON on stdout", async () => {
    const engine = createTestEngine();
    const output = createIo();

    const originalExitCode = process.exitCode;
    const code = await runCli(engine, {
      argv: ["list"],
      principal: null,
      io: output.io,
    });

    expect(code).toBe(0);
    expect(process.exitCode).toBe(originalExitCode);
    expect(output.stdout).toEqual([`${JSON.stringify(engine.list())}\n`]);
    expect(output.stderr).toEqual([]);
  });

  it("describes one capability as canonical JSON on stdout", async () => {
    const engine = createTestEngine();
    const output = createIo();

    const code = await runCli(engine, {
      argv: ["describe", "example.echo"],
      principal: null,
      io: output.io,
    });

    expect(code).toBe(0);
    expect(output.stdout).toEqual([
      `${JSON.stringify(engine.describe("example.echo"))}\n`,
    ]);
    expect(output.stderr).toEqual([]);
  });

  it("runs a capability through engine.invoke with trusted boundary context", async () => {
    const principal = { id: "local:developer" } as const;
    const controller = new AbortController();
    const observeRun = vi.fn(async (_args: RunObserverArgs) => ({
      result: "HELLO",
    }));
    const engine = createTestEngine({
      access: "authenticated",
      run: observeRun,
    });
    const invoke = vi.spyOn(engine, "invoke");
    const output = createIo();

    const code = await runCli(engine, {
      argv: ["run", "example.echo", "--input", '{"value":"hello"}'],
      principal,
      signal: controller.signal,
      io: output.io,
    });

    expect(code).toBe(0);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(
      "example.echo",
      { value: "hello" },
      {
        source: "cli",
        principal,
        signal: controller.signal,
      },
    );
    expect(observeRun).toHaveBeenCalledTimes(1);
    expect(observeRun.mock.calls[0]?.[0].context).toMatchObject({
      source: "cli",
      principal,
      signal: controller.signal,
    });
    expect(output.stdout).toEqual(['{"result":"HELLO"}\n']);
    expect(output.stderr).toEqual([]);
    expect(output.readStdin).not.toHaveBeenCalled();
  });

  it("reads run input from stdin only when --stdin is selected", async () => {
    const engine = createTestEngine();
    const invoke = vi.spyOn(engine, "invoke");
    const output = createIo('{"value":"from-stdin"}');

    const code = await runCli(engine, {
      argv: ["run", "example.echo", "--stdin"],
      principal: null,
      io: output.io,
    });

    expect(code).toBe(0);
    expect(output.readStdin).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(
      "example.echo",
      { value: "from-stdin" },
      expect.objectContaining({ source: "cli", principal: null }),
    );
    expect(output.stdout).toEqual(['{"result":"from-stdin"}\n']);
  });

  it("rejects malformed UTF-8 stdin as invalid usage without invoking the engine", async () => {
    const engine = createTestEngine();
    const invoke = vi.spyOn(engine, "invoke");
    const output = createIo();
    const io: CliIo = {
      ...output.io,
      readStdin: () =>
        readUtf8(
          (async function* () {
            yield new TextEncoder().encode('{"value":"');
            yield Uint8Array.of(0xff);
            yield new TextEncoder().encode('"}');
          })(),
        ),
    };

    const code = await runCli(engine, {
      argv: ["run", "example.echo", "--stdin"],
      principal: null,
      io,
    });

    expect(code).toBe(2);
    expect(invoke).not.toHaveBeenCalled();
    expect(output.stdout).toEqual([]);
    expect(JSON.parse(output.stderr.join(""))).toEqual({
      error: {
        code: "INVALID_USAGE",
        message: "Input must be valid UTF-8.",
      },
    });
  });

  it("returns exit code 2 for malformed JSON without invoking the engine", async () => {
    const engine = createTestEngine();
    const invoke = vi.spyOn(engine, "invoke");
    const output = createIo();

    const code = await runCli(engine, {
      argv: ["run", "example.echo", "--input", "not-json"],
      principal: null,
      io: output.io,
    });

    expect(code).toBe(2);
    expect(invoke).not.toHaveBeenCalled();
    expect(output.stdout).toEqual([]);
    expect(JSON.parse(output.stderr.join(""))).toEqual({
      error: {
        code: "INVALID_USAGE",
        message: "Input must be valid JSON.",
      },
    });
  });

  it.each([
    [],
    ["unknown"],
    ["list", "unexpected"],
    ["describe"],
    ["run", "example.echo"],
    ["run", "example.echo", "--input"],
    ["run", "example.echo", "--input", "{}", "--stdin"],
    ["run", "example.echo", "--actor", "user:42"],
    ["run", "example.echo", "--role", "admin"],
    ["run", "example.echo", "--user", "user:42"],
  ])("returns exit code 2 for invalid usage: %j", async (...argv) => {
    const engine = createTestEngine();
    const invoke = vi.spyOn(engine, "invoke");
    const output = createIo();

    const code = await runCli(engine, {
      argv,
      principal: null,
      io: output.io,
    });

    expect(code).toBe(2);
    expect(invoke).not.toHaveBeenCalled();
    expect(output.stdout).toEqual([]);
    expect(JSON.parse(output.stderr.join("")).error).toMatchObject({
      code: "INVALID_USAGE",
      message: expect.stringContaining("Usage:"),
    });
  });

  it("returns exit code 1 and serializes only safe EngineError fields", async () => {
    const engine = createTestEngine({
      run: async () => {
        throw new EngineError({
          code: "EXECUTION_FAILED",
          message: "Ticket was not found.",
          publicDetails: { ticketId: "T-404" },
          cause: new Error("secret database location"),
        });
      },
    });
    const output = createIo();

    const code = await runCli(engine, {
      argv: ["run", "example.echo", "--input", '{"value":"hello"}'],
      principal: null,
      io: output.io,
    });

    expect(code).toBe(1);
    expect(output.stdout).toEqual([]);
    expect(output.stderr).toEqual([
      '{"error":{"code":"EXECUTION_FAILED","message":"Ticket was not found.","publicDetails":{"ticketId":"T-404"}}}\n',
    ]);
    expect(JSON.parse(output.stderr.join(""))).toEqual({
      error: {
        code: "EXECUTION_FAILED",
        message: "Ticket was not found.",
        publicDetails: { ticketId: "T-404" },
      },
    });
    expect(output.stderr.join("")).not.toContain("secret database location");
    expect(output.stderr.join("")).not.toContain("stack");
  });

  it("contains a throwing EngineError message accessor", async () => {
    const error = new EngineError({
      code: "EXECUTION_FAILED",
      message: "Initial public message.",
    });
    Object.defineProperty(error, "message", {
      configurable: true,
      get() {
        throw new Error("secret backend path: /srv/private/database");
      },
    });
    const engine = createTestEngine();
    vi.spyOn(engine, "invoke").mockRejectedValue(error);
    const output = createIo();

    const invocation = runCli(engine, {
      argv: ["run", "example.echo", "--input", '{"value":"hello"}'],
      principal: null,
      io: output.io,
    });

    await expect(invocation).resolves.toBe(1);
    expect(output.stdout).toEqual([]);
    expect(output.stderr).toEqual([
      '{"error":{"code":"EXECUTION_FAILED","message":"CLI execution failed."}}\n',
    ]);
    expect(output.stderr.join("")).not.toContain("secret backend path");
    expect(output.stderr.join("")).not.toContain("stack");
  });

  it("contains a throwing EngineError publicDetails accessor", async () => {
    const error = new EngineError({
      code: "FORBIDDEN",
      message: "Capability access is forbidden.",
    });
    Object.defineProperty(error, "publicDetails", {
      configurable: true,
      get() {
        throw new Error("secret authorization token");
      },
    });
    const engine = createTestEngine({
      run: async () => {
        throw error;
      },
    });
    const output = createIo();

    const invocation = runCli(engine, {
      argv: ["run", "example.echo", "--input", '{"value":"hello"}'],
      principal: null,
      io: output.io,
    });

    await expect(invocation).resolves.toBe(1);
    expect(output.stdout).toEqual([]);
    expect(output.stderr).toEqual([
      '{"error":{"code":"FORBIDDEN","message":"Capability access is forbidden."}}\n',
    ]);
    expect(output.stderr.join("")).not.toContain("secret authorization token");
    expect(output.stderr.join("")).not.toContain("stack");
  });

  it("maps an unauthenticated invocation to exit code 1 before run", async () => {
    const observeRun = vi.fn(async (_args: RunObserverArgs) => ({
      result: "never",
    }));
    const engine = createTestEngine({
      access: "authenticated",
      run: observeRun,
    });
    const output = createIo();

    const code = await runCli(engine, {
      argv: ["run", "example.echo", "--input", '{"value":"hello"}'],
      principal: null,
      io: output.io,
    });

    expect(code).toBe(1);
    expect(observeRun).not.toHaveBeenCalled();
    expect(JSON.parse(output.stderr.join(""))).toEqual({
      error: {
        code: "UNAUTHENTICATED",
        message: "Authentication is required.",
      },
    });
  });

  it("invokes an unknown capability exactly once without a list precheck", async () => {
    const engine = createTestEngine();
    const invoke = vi.spyOn(engine, "invoke");
    const list = vi.spyOn(engine, "list");
    const output = createIo();

    const code = await runCli(engine, {
      argv: ["run", "missing.capability", "--input", "{}"],
      principal: null,
      io: output.io,
    });

    expect(code).toBe(1);
    expect(list).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(
      "missing.capability",
      {},
      expect.objectContaining({ source: "cli", principal: null }),
    );
    expect(output.stdout).toEqual([]);
    expect(JSON.parse(output.stderr.join(""))).toEqual({
      error: {
        code: "CAPABILITY_NOT_FOUND",
        message: "Capability not found.",
        publicDetails: { capabilityId: "missing.capability" },
      },
    });
  });

  it("propagates host cancellation and maps it to exit code 1", async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers<AbortSignal>();
    const engine = createTestEngine({
      run: async ({ context }) => {
        started.resolve(context.signal);
        return new Promise(() => undefined);
      },
    });
    const output = createIo();

    const invocation = runCli(engine, {
      argv: ["run", "example.echo", "--input", '{"value":"hello"}'],
      principal: null,
      signal: controller.signal,
      io: output.io,
    });
    const contextSignal = await started.promise;
    controller.abort(new Error("host cancelled"));
    const code = await invocation;

    expect(contextSignal).toBe(controller.signal);
    expect(contextSignal.aborted).toBe(true);
    expect(code).toBe(1);
    expect(output.stdout).toEqual([]);
    expect(JSON.parse(output.stderr.join(""))).toEqual({
      error: {
        code: "CANCELLED",
        message: "Capability invocation was cancelled.",
      },
    });
    expect(output.stderr.join("")).not.toContain("host cancelled");
  });

  it("does not accept identity spoofed through business input", async () => {
    const observeRun = vi.fn(async () => ({ result: "never" }));
    const engine = createEngine({
      name: "spoof-test",
      version: "0.1.0-test",
      capabilities: {
        "example.secured": defineCapability({
          description: "Rejects anonymous callers.",
          input: z.object({
            principal: z.object({ id: z.string() }),
            actor: z.string(),
            role: z.string(),
          }),
          output: z.object({ result: z.string() }),
          access: "authenticated",
          run: observeRun,
        }),
      },
    });
    const output = createIo();

    const code = await runCli(engine, {
      argv: [
        "run",
        "example.secured",
        "--input",
        '{"principal":{"id":"admin"},"actor":"admin","role":"admin"}',
      ],
      principal: null,
      io: output.io,
    });

    expect(code).toBe(1);
    expect(observeRun).not.toHaveBeenCalled();
    expect(output.stdout).toEqual([]);
    expect(JSON.parse(output.stderr.join(""))).toEqual({
      error: {
        code: "UNAUTHENTICATED",
        message: "Authentication is required.",
      },
    });
    expect(output.stderr.join("")).not.toContain("admin");
  });

  it("requires the trusted principal option at runtime", async () => {
    const engine = createTestEngine();
    const invoke = vi.spyOn(engine, "invoke");
    const output = createIo();

    const code = await runCli(engine, {
      argv: ["run", "example.echo", "--input", '{"value":"hello"}'],
      io: output.io,
    } as unknown as Parameters<typeof runCli>[1]);

    expect(code).toBe(2);
    expect(invoke).not.toHaveBeenCalled();
    expect(JSON.parse(output.stderr.join(""))).toEqual({
      error: {
        code: "INVALID_USAGE",
        message: "The trusted principal option is required.",
      },
    });
  });

  it("maps adapter failures to a safe structured execution error", async () => {
    const engine = createTestEngine();
    const output = createIo();
    const io: CliIo = {
      ...output.io,
      readStdin: async () => {
        throw new Error("secret local path");
      },
    };

    const code = await runCli(engine, {
      argv: ["run", "example.echo", "--stdin"],
      principal: null,
      io,
    });

    expect(code).toBe(1);
    expect(JSON.parse(output.stderr.join(""))).toEqual({
      error: {
        code: "EXECUTION_FAILED",
        message: "CLI execution failed.",
      },
    });
    expect(output.stderr.join("")).not.toContain("secret local path");
  });

  it("renders human output as deterministic pretty-printed JSON", async () => {
    const engine = createTestEngine();
    const output = createIo();

    const code = await runCli(engine, {
      argv: ["run", "example.echo", "--input", '{"value":"hello"}'],
      principal: null,
      format: "human",
      io: output.io,
    });

    expect(code).toBe(0);
    expect(output.stdout).toEqual(['{\n  "result": "hello"\n}\n']);
    expect(output.stderr).toEqual([]);
  });

  it("awaits a successful asynchronous stdout write", async () => {
    const engine = createTestEngine();
    const output = createIo();
    const write = Promise.withResolvers<void>();
    const writeStarted = Promise.withResolvers<void>();
    let settled = false;
    const io: CliIo = {
      ...output.io,
      writeStdout: () => {
        writeStarted.resolve();
        return write.promise;
      },
    };

    const invocation = runCli(engine, {
      argv: ["list"],
      principal: null,
      io,
    });
    void invocation.then(() => {
      settled = true;
    });

    await writeStarted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    write.resolve();
    await expect(invocation).resolves.toBe(0);
  });

  it.each([
    [
      "throws",
      () => {
        throw new Error("secret output destination");
      },
    ],
    [
      "rejects",
      async () => {
        throw new Error("secret output destination");
      },
    ],
  ])(
    "maps a stdout writer that %s to a safe execution failure",
    async (_case, writeStdout) => {
      const engine = createTestEngine();
      const output = createIo();
      const io: CliIo = { ...output.io, writeStdout };

      await expect(
        runCli(engine, {
          argv: ["list"],
          principal: null,
          io,
        }),
      ).resolves.toBe(1);
      expect(output.stderr).toEqual([
        '{"error":{"code":"EXECUTION_FAILED","message":"CLI execution failed."}}\n',
      ]);
      expect(output.stderr.join("")).not.toContain("secret output destination");
    },
  );

  it("awaits a successful asynchronous stderr write", async () => {
    const engine = createTestEngine();
    const output = createIo();
    const write = Promise.withResolvers<void>();
    const writeStarted = Promise.withResolvers<void>();
    let settled = false;
    const io: CliIo = {
      ...output.io,
      writeStderr: () => {
        writeStarted.resolve();
        return write.promise;
      },
    };

    const invocation = runCli(engine, {
      argv: ["unknown"],
      principal: null,
      io,
    });
    void invocation.then(() => {
      settled = true;
    });

    await writeStarted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    write.resolve();
    await expect(invocation).resolves.toBe(2);
  });

  it.each([
    [
      "throws",
      () => {
        throw new Error("secret stderr destination");
      },
    ],
    [
      "rejects",
      async () => {
        throw new Error("secret stderr destination");
      },
    ],
  ])(
    "contains a stderr writer that %s so runCli still resolves",
    async (_case, writeStderr) => {
      const engine = createTestEngine();
      const output = createIo();
      const io: CliIo = { ...output.io, writeStderr };

      await expect(
        runCli(engine, {
          argv: ["unknown"],
          principal: null,
          io,
        }),
      ).resolves.toBe(2);
    },
  );
});
