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

type Settlement<Value> =
  | { readonly status: "fulfilled"; readonly value: Value }
  | { readonly status: "rejected"; readonly reason: unknown }
  | { readonly status: "pending" };

async function settleByNextTurn<Value>(
  promise: Promise<Value>,
): Promise<Settlement<Value>> {
  return Promise.race([
    promise.then<Settlement<Value>, Settlement<Value>>(
      (value) => ({ status: "fulfilled", value }),
      (reason: unknown) => ({ status: "rejected", reason }),
    ),
    new Promise<Settlement<Value>>((resolve) => {
      setImmediate(() => resolve({ status: "pending" }));
    }),
  ]);
}

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
  it.each([
    ["zero", 0],
    ["a negative value", -1],
    ["a fractional value", 1.5],
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
    ["a value above the timer limit", 2_147_483_648],
  ])("rejects %s as timeoutMs at engine construction", (_case, timeoutMs) => {
    const emitWarning = vi.spyOn(process, "emitWarning");
    try {
      expect(() =>
        createEngine({
          name: "invalid-timeout-engine",
          version: "0.1.0",
          capabilities: {
            invalid: capability(
              async ({ input: value }) => ({ result: value.value }),
              timeoutMs,
            ),
          },
        }),
      ).toThrow(TypeError);
      expect(emitWarning).not.toHaveBeenCalled();
    } finally {
      emitWarning.mockRestore();
    }
  });

  it("accepts the inclusive timeoutMs boundaries and expires at the maximum deadline", async () => {
    vi.useFakeTimers();
    const emitWarning = vi.spyOn(process, "emitWarning");
    let observedSignal: AbortSignal | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const engine = createEngine({
      name: "timeout-boundary-engine",
      version: "0.1.0",
      capabilities: {
        minimum: capability(
          async ({ input: value }) => ({ result: value.value }),
          1,
        ),
        maximum: capability(async ({ context }) => {
          observedSignal = context.signal;
          markStarted?.();
          await new Promise<void>(() => undefined);
          return { result: "unreachable" };
        }, 2_147_483_647),
      },
    });

    try {
      expect(engine.describe("minimum").timeoutMs).toBe(1);
      expect(engine.describe("maximum").timeoutMs).toBe(2_147_483_647);
      const invocation = engine.invoke("maximum", { value: "safe" });
      const cancellation = expect(invocation).rejects.toMatchObject({
        code: "CANCELLED",
      });
      await started;

      await vi.advanceTimersByTimeAsync(2_147_483_646);
      expect(observedSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      await cancellation;
      expect(observedSignal?.aborted).toBe(true);
      expect(emitWarning).not.toHaveBeenCalled();
    } finally {
      emitWarning.mockRestore();
      vi.useRealTimers();
    }
  });

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

  it("does not wait for a pending asynchronous started event hook", async () => {
    const events: EngineEvent["type"][] = [];
    const pending = new Promise<void>(() => undefined);
    const run = vi.fn(
      async ({ input: value }: { input: { value: string } }) => ({
        result: value.value,
      }),
    );
    const engine = createEngine({
      name: "pending-started-event-engine",
      version: "0.1.0",
      capabilities: { echo: capability(run) },
      onEvent(event) {
        events.push(event.type);
        return event.type === "invocation.started" ? pending : undefined;
      },
    });

    const settlement = await settleByNextTurn(
      engine.invoke("echo", { value: "safe" }),
    );

    expect(settlement).toEqual({
      status: "fulfilled",
      value: { result: "safe" },
    });
    expect(run).toHaveBeenCalledOnce();
    expect(events).toEqual(["invocation.started", "invocation.completed"]);
  });

  it("does not wait for a pending asynchronous completed event hook", async () => {
    const events: EngineEvent["type"][] = [];
    const pending = new Promise<void>(() => undefined);
    const engine = createEngine({
      name: "pending-completed-event-engine",
      version: "0.1.0",
      capabilities: {
        echo: capability(async ({ input: value }) => ({ result: value.value })),
      },
      onEvent(event) {
        events.push(event.type);
        return event.type === "invocation.completed" ? pending : undefined;
      },
    });

    const settlement = await settleByNextTurn(
      engine.invoke("echo", { value: "safe" }),
    );

    expect(settlement).toEqual({
      status: "fulfilled",
      value: { result: "safe" },
    });
    expect(events).toEqual(["invocation.started", "invocation.completed"]);
  });

  it("does not wait for a pending asynchronous failed event hook", async () => {
    const events: EngineEvent["type"][] = [];
    const pending = new Promise<void>(() => undefined);
    const engine = createEngine({
      name: "pending-failed-event-engine",
      version: "0.1.0",
      capabilities: {
        echo: capability(async () => {
          throw new Error("private capability failure");
        }),
      },
      onEvent(event) {
        events.push(event.type);
        return event.type === "invocation.failed" ? pending : undefined;
      },
    });

    const settlement = await settleByNextTurn(
      engine.invoke("echo", { value: "safe" }),
    );

    expect(settlement).toMatchObject({
      status: "rejected",
      reason: { code: "EXECUTION_FAILED" },
    });
    expect(events).toEqual(["invocation.started", "invocation.failed"]);
  });

  it("observes asynchronous hook and diagnostic logger rejections", async () => {
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    const rejectingLoggerResult = Promise.reject(
      new Error("private logger failure"),
    );
    void rejectingLoggerResult.then(undefined, () => undefined);
    const observeLoggerRejection = vi.spyOn(rejectingLoggerResult, "then");
    const logger: EngineLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(() => rejectingLoggerResult) as EngineLogger["error"],
    };
    const engine = createEngine({
      name: "rejecting-async-events-engine",
      version: "0.1.0",
      capabilities: {
        echo: capability(async ({ input: value }) => ({ result: value.value })),
      },
      logger,
      async onEvent() {
        throw new Error("private telemetry failure");
      },
    });

    process.prependListener("unhandledRejection", onUnhandledRejection);
    try {
      await expect(engine.invoke("echo", { value: "safe" })).resolves.toEqual({
        result: "safe",
      });
      await new Promise<void>((resolve) => {
        setImmediate(() => setImmediate(resolve));
      });

      expect(logger.error).toHaveBeenCalledTimes(2);
      expect(logger.error).toHaveBeenCalledWith("Engine event hook failed.", {
        eventType: "invocation.started",
        requestId: expect.any(String),
      });
      expect(logger.error).toHaveBeenCalledWith("Engine event hook failed.", {
        eventType: "invocation.completed",
        requestId: expect.any(String),
      });
      expect(observeLoggerRejection.mock.calls.length).toBeGreaterThanOrEqual(
        2,
      );
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandledRejection);
    }
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

  it("clears a successful invocation timeout before emitting completion", async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    let completionObserved: (() => void) | undefined;
    const completionStarted = new Promise<void>((resolve) => {
      completionObserved = resolve;
    });
    let releaseCompletion: (() => void) | undefined;
    const completionPending = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    const engine = createEngine({
      name: "completion-timeout-engine",
      version: "0.1.0",
      capabilities: {
        echo: capability(async ({ input: value, context }) => {
          observedSignal = context.signal;
          return { result: value.value };
        }, 10),
      },
      onEvent(event) {
        if (event.type !== "invocation.completed") return undefined;
        completionObserved?.();
        return completionPending;
      },
    });

    try {
      const invocation = engine.invoke("echo", { value: "safe" });
      await completionStarted;
      await vi.advanceTimersByTimeAsync(11);
      releaseCompletion?.();

      await expect(invocation).resolves.toEqual({ result: "safe" });
      expect(observedSignal?.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
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
