import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createEngine,
  defineCapability,
  EngineError,
  type EngineErrorCode,
  type EngineSchema,
  type ExecutionContext,
} from "../src/index.js";

const input = z.object({ value: z.string().min(1) });
const output = z.object({ result: z.string() });

function testSchema<Input, Output>(
  validate: (
    value: unknown,
  ) =>
    | { value: Output }
    | { issues: ReadonlyArray<{ message: string }> }
    | Promise<
        { value: Output } | { issues: ReadonlyArray<{ message: string }> }
      >,
): EngineSchema<Input, Output> {
  return {
    "~standard": {
      version: 1,
      vendor: "core-contract-test",
      validate,
      jsonSchema: {
        input: () => ({ type: "object" }),
        output: () => ({ type: "object" }),
      },
    },
  };
}

async function expectEngineError(
  promise: Promise<unknown>,
  code: EngineErrorCode,
): Promise<EngineError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(EngineError);
    expect((error as EngineError).code).toBe(code);
    return error as EngineError;
  }
  throw new Error(`Expected EngineError with code ${code}.`);
}

function createEchoCapability(
  overrides: {
    run?: (args: {
      input: { value: string };
      context: ExecutionContext;
    }) => Promise<{ result: string }>;
  } = {},
) {
  return defineCapability({
    title: "Echo",
    description: "Echo a validated value.",
    input,
    output,
    access: "public",
    annotations: {
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: false,
    },
    run:
      overrides.run ??
      (async ({ input: value }) => ({
        result: value.value,
      })),
  });
}

describe("the core v0.1 contract", () => {
  it("runs validation, authorization, execution, and output validation in order", async () => {
    const order: string[] = [];
    const orderedInput = z.object({
      value: z.string().transform((value) => {
        order.push("input");
        return value.trim();
      }),
    });
    const orderedOutput = z.object({
      result: z
        .string()
        .transform((value) => {
          order.push("output");
          return value.toUpperCase();
        })
        .pipe(z.string()),
    });
    const engine = createEngine({
      name: "pipeline-engine",
      version: "0.1.0",
      capabilities: {
        ordered: defineCapability({
          description: "Prove the normative execution order.",
          input: orderedInput,
          output: orderedOutput,
          access: ({ input: value }) => {
            order.push("access");
            return value.value === "allowed";
          },
          async run({ input: value }) {
            order.push("run");
            return { result: value.value };
          },
        }),
      },
    });

    await expect(
      engine.invoke("ordered", { value: " allowed " }),
    ).resolves.toEqual({ result: "ALLOWED" });
    expect(order).toEqual(["input", "access", "run", "output"]);
  });

  it("lists and describes capabilities with their original JSON Schemas", () => {
    const engine = createEngine({
      name: "contract-engine",
      version: "0.1.0",
      capabilities: { "example.echo": createEchoCapability() },
    });

    expect(engine.name).toBe("contract-engine");
    expect(engine.version).toBe("0.1.0");
    expect(engine.list()).toEqual([
      {
        id: "example.echo",
        title: "Echo",
        description: "Echo a validated value.",
        annotations: {
          readOnly: true,
          destructive: false,
          idempotent: true,
          openWorld: false,
        },
      },
    ]);
    expect(engine.describe("example.echo")).toMatchObject({
      id: "example.echo",
      title: "Echo",
      description: "Echo a validated value.",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
    });
  });

  it("rejects non-object root schemas when creating an engine", () => {
    const invalidInput = defineCapability({
      description: "Invalid scalar input contract.",
      input: z.string(),
      output,
      access: "public",
      async run({ input }) {
        return { result: input };
      },
    });
    const invalidOutput = defineCapability({
      description: "Invalid scalar output contract.",
      input,
      output: z.string(),
      access: "public",
      async run({ input: value }) {
        return value.value;
      },
    });

    expect(() =>
      createEngine({
        name: "invalid-engine",
        version: "0.1.0",
        capabilities: { invalid: invalidInput },
      }),
    ).toThrow("Capability invalid input schema must have an object root.");
    expect(() =>
      createEngine({
        name: "invalid-engine",
        version: "0.1.0",
        capabilities: { invalid: invalidOutput },
      }),
    ).toThrow("Capability invalid output schema must have an object root.");
  });

  it("uses stable codes for lookup, input, and output failures", async () => {
    const invalidOutput = createEchoCapability({
      async run() {
        return { result: 42 } as unknown as { result: string };
      },
    });
    const engine = createEngine({
      name: "errors-engine",
      version: "0.1.0",
      capabilities: { "example.echo": invalidOutput },
    });

    await expectEngineError(
      engine.invoke("missing" as "example.echo", { value: "ok" }),
      "CAPABILITY_NOT_FOUND",
    );
    await expectEngineError(
      engine.invoke("constructor" as "example.echo", { value: "ok" }),
      "CAPABILITY_NOT_FOUND",
    );
    const inputError = await expectEngineError(
      engine.invoke("example.echo", { value: "" }),
      "INPUT_INVALID",
    );
    expect(inputError.publicDetails).toMatchObject({
      issues: expect.any(Array),
    });
    await expectEngineError(
      engine.invoke("example.echo", { value: "ok" }),
      "OUTPUT_INVALID",
    );
  });

  it("passes the complete authorization arguments and denies before run", async () => {
    const access = vi.fn(async () => false);
    const run = vi.fn(
      async ({ input: value }: { input: { value: string } }) => ({
        result: value.value,
      }),
    );
    const capability = defineCapability({
      description: "Authorize an echo operation.",
      input,
      output,
      access,
      run,
    });
    const engine = createEngine({
      name: "authorization-engine",
      version: "0.1.0",
      capabilities: { "example.echo": capability },
    });

    await expectEngineError(
      engine.invoke("example.echo", { value: "anonymous" }),
      "UNAUTHENTICATED",
    );
    await expectEngineError(
      engine.invoke(
        "example.echo",
        { value: "identified" },
        { principal: { id: "user:42" }, requestId: "auth-request" },
      ),
      "FORBIDDEN",
    );
    expect(run).not.toHaveBeenCalled();
    expect(access).toHaveBeenLastCalledWith(
      expect.objectContaining({
        principal: { id: "user:42" },
        input: { value: "identified" },
        capabilityId: "example.echo",
        context: expect.objectContaining({ requestId: "auth-request" }),
      }),
    );
  });

  it("preserves EngineError and normalizes unknown handler failures", async () => {
    const expected = new EngineError({
      code: "EXECUTION_FAILED",
      message: "The downstream record does not exist.",
      publicDetails: { recordId: "R-1" },
      cause: new Error("private provider detail"),
    });
    const businessEngine = createEngine({
      name: "business-error-engine",
      version: "0.1.0",
      capabilities: {
        fail: createEchoCapability({
          async run() {
            throw expected;
          },
        }),
      },
    });
    const unknownEngine = createEngine({
      name: "unknown-error-engine",
      version: "0.1.0",
      capabilities: {
        fail: createEchoCapability({
          async run() {
            throw new Error("secret internal failure");
          },
        }),
      },
    });

    await expect(businessEngine.invoke("fail", { value: "x" })).rejects.toBe(
      expected,
    );
    const normalized = await expectEngineError(
      unknownEngine.invoke("fail", { value: "x" }),
      "EXECUTION_FAILED",
    );
    expect(normalized.message).toBe("Capability execution failed.");
    expect(normalized.publicDetails).toBeUndefined();
    expect(normalized.cause).toBeInstanceOf(Error);
  });

  it("does not let schema validators escape stage-specific error codes", async () => {
    const injected = new EngineError({
      code: "FORBIDDEN",
      message: "A validator must not control runtime authorization codes.",
    });
    const throwingInput = testSchema<{ value: string }, { value: string }>(
      () => {
        throw injected;
      },
    );
    const throwingOutput = testSchema<{ result: string }, { result: string }>(
      () => {
        throw injected;
      },
    );
    const inputEngine = createEngine({
      name: "throwing-input-engine",
      version: "0.1.0",
      capabilities: {
        echo: defineCapability({
          description: "Reject a schema exception as invalid input.",
          input: throwingInput,
          output,
          access: "public",
          async run({ input: value }) {
            return { result: value.value };
          },
        }),
      },
    });
    const outputEngine = createEngine({
      name: "throwing-output-engine",
      version: "0.1.0",
      capabilities: {
        echo: defineCapability({
          description: "Reject a schema exception as invalid output.",
          input,
          output: throwingOutput,
          access: "public",
          async run({ input: value }) {
            return { result: value.value };
          },
        }),
      },
    });

    await expectEngineError(
      inputEngine.invoke("echo", { value: "x" }),
      "INPUT_INVALID",
    );
    await expectEngineError(
      outputEngine.invoke("echo", { value: "x" }),
      "OUTPUT_INVALID",
    );
  });
});
