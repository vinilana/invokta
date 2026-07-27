import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createEngine,
  defineCapability,
  type EngineEvent,
  type EngineLogger,
  type EngineSchema,
} from "../src/index.js";

const input = z.object({ value: z.string() });
const output = z.object({ result: z.string() });

function capability(
  run: (args: {
    input: { value: string };
    context: { signal: AbortSignal; logger: EngineLogger };
  }) => Promise<{ result: string }>,
  timeoutMs?: number,
) {
  return defineCapability({
    description: "Exercise runtime events and cancellation.",
    input,
    output,
    access: "public",
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    run,
  });
}

describe("events and cancellation", () => {
  it("emits the exact minimal started and completed events", async () => {
    const events: EngineEvent[] = [];
    const engine = createEngine({
      name: "events-engine",
      version: "0.1.0",
      capabilities: {
        echo: capability(async ({ input }) => ({ result: input.value })),
      },
      onEvent(event) {
        events.push(event);
      },
    });

    await engine.invoke(
      "echo",
      { value: "safe payload" },
      {
        requestId: "request-success",
        source: "direct",
        principal: { id: "user:7" },
      },
    );

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      type: "invocation.started",
      requestId: "request-success",
      capabilityId: "echo",
      source: "direct",
      principalId: "user:7",
      startedAt: expect.any(String),
    });
    expect(events[1]).toEqual({
      type: "invocation.completed",
      requestId: "request-success",
      capabilityId: "echo",
      durationMs: expect.any(Number),
    });
    expect(JSON.stringify(events)).not.toContain("safe payload");
  });

  it("emits a failed event with the normalized code", async () => {
    const events: EngineEvent[] = [];
    const engine = createEngine({
      name: "failed-events-engine",
      version: "0.1.0",
      capabilities: {
        echo: capability(async ({ input }) => ({ result: input.value })),
      },
      onEvent(event) {
        events.push(event);
      },
    });

    await expect(
      engine.invoke("echo", { value: 42 } as never),
    ).rejects.toMatchObject({
      code: "INPUT_INVALID",
    });
    expect(events.map((event) => event.type)).toEqual([
      "invocation.started",
      "invocation.failed",
    ]);
    expect(events[1]).toEqual({
      type: "invocation.failed",
      requestId: expect.any(String),
      capabilityId: "echo",
      durationMs: expect.any(Number),
      code: "INPUT_INVALID",
    });
  });

  it("does not let observability hook failures alter invocation results", async () => {
    const logger: EngineLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const engine = createEngine({
      name: "failing-events-engine",
      version: "0.1.0",
      capabilities: {
        echo: capability(async ({ input }) => ({ result: input.value })),
      },
      logger,
      onEvent() {
        throw new Error("telemetry unavailable");
      },
    });

    await expect(engine.invoke("echo", { value: "safe" })).resolves.toEqual({
      result: "safe",
    });
    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(logger.error).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ input: expect.anything() }),
    );
  });

  it("cancels before running when the caller signal is already aborted", async () => {
    const run = vi.fn(async ({ input }: { input: { value: string } }) => ({
      result: input.value,
    }));
    const controller = new AbortController();
    controller.abort();
    const engine = createEngine({
      name: "cancelled-engine",
      version: "0.1.0",
      capabilities: { echo: capability(run) },
    });

    await expect(
      engine.invoke("echo", { value: "x" }, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(run).not.toHaveBeenCalled();
  });

  it("aborts the context signal and returns CANCELLED on timeout", async () => {
    let observedSignal: AbortSignal | undefined;
    const engine = createEngine({
      name: "timeout-engine",
      version: "0.1.0",
      capabilities: {
        slow: capability(async ({ context }) => {
          observedSignal = context.signal;
          await new Promise<void>(() => undefined);
          return { result: "unreachable" };
        }, 10),
      },
    });

    await expect(engine.invoke("slow", { value: "x" })).rejects.toMatchObject({
      code: "CANCELLED",
    });
    expect(observedSignal?.aborted).toBe(true);
  });

  it("applies the timeout to asynchronous output validation", async () => {
    const delayedOutput: EngineSchema<{ result: string }, { result: string }> =
      {
        "~standard": {
          version: 1,
          vendor: "async-output-test",
          async validate(value) {
            await new Promise((resolve) => setTimeout(resolve, 30));
            return { value: value as { result: string } };
          },
          jsonSchema: {
            input: () => ({ type: "object" }),
            output: () => ({ type: "object" }),
          },
        },
      };
    const engine = createEngine({
      name: "async-output-engine",
      version: "0.1.0",
      capabilities: {
        echo: defineCapability({
          description: "Time out asynchronous output validation.",
          input,
          output: delayedOutput,
          access: "public",
          timeoutMs: 5,
          async run({ input: value }) {
            return { result: value.value };
          },
        }),
      },
    });

    await expect(engine.invoke("echo", { value: "x" })).rejects.toMatchObject({
      code: "CANCELLED",
    });
  });

  it("starts the capability timeout only after authorization completes", async () => {
    const engine = createEngine({
      name: "authorization-timeout-engine",
      version: "0.1.0",
      capabilities: {
        echo: defineCapability({
          description:
            "Exclude authorization latency from the handler timeout.",
          input,
          output,
          access: async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            return true;
          },
          timeoutMs: 5,
          async run({ input: value }) {
            return { result: value.value };
          },
        }),
      },
    });

    await expect(engine.invoke("echo", { value: "x" })).resolves.toEqual({
      result: "x",
    });
  });

  it("injects the configured logger into the execution context", async () => {
    const logger: EngineLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const observe = vi.fn();
    const engine = createEngine({
      name: "logger-engine",
      version: "0.1.0",
      capabilities: {
        echo: capability(async ({ input, context }) => {
          observe(context.logger);
          return { result: input.value };
        }),
      },
      logger,
    });

    await engine.invoke("echo", { value: "x" });
    expect(observe).toHaveBeenCalledExactlyOnceWith(logger);
  });
});
