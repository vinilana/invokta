import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createEngine,
  defineCapability,
  EngineError,
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
  it("contains hostile native signal overrides without changing success", async () => {
    const privateFailure = new Error("private signal override failure");
    const controller = new AbortController();
    const signal = controller.signal;
    const overriddenRemove = vi.fn(() => {
      throw privateFailure;
    });
    Object.defineProperties(signal, {
      aborted: {
        configurable: true,
        get() {
          throw privateFailure;
        },
      },
      reason: {
        configurable: true,
        get() {
          throw privateFailure;
        },
      },
      addEventListener: {
        configurable: true,
        value() {
          throw privateFailure;
        },
      },
      removeEventListener: {
        configurable: true,
        value: overriddenRemove,
      },
    });
    const events: EngineEvent[] = [];
    const run = vi.fn(async ({ input: value }) => ({ result: value.value }));
    const engine = createEngine({
      name: "hostile-native-signal-engine",
      version: "0.1.0",
      capabilities: { echo: capability(run, 100) },
      onEvent(event) {
        events.push(event);
      },
    });

    await expect(
      engine.invoke("echo", { value: "safe" }, { signal }),
    ).resolves.toEqual({ result: "safe" });
    expect(run).toHaveBeenCalledOnce();
    expect(overriddenRemove).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual([
      "invocation.started",
      "invocation.completed",
    ]);
  });

  it("does not let signal cleanup replace the original capability failure", async () => {
    const cleanupFailure = new Error("private signal cleanup failure");
    const expected = new EngineError({
      code: "EXECUTION_FAILED",
      message: "The original capability failure.",
      publicDetails: { retryable: false },
    });
    const signal = new AbortController().signal;
    const overriddenRemove = vi.fn(() => {
      throw cleanupFailure;
    });
    Object.defineProperty(signal, "removeEventListener", {
      configurable: true,
      value: overriddenRemove,
    });
    const events: EngineEvent[] = [];
    const engine = createEngine({
      name: "signal-cleanup-failure-engine",
      version: "0.1.0",
      capabilities: {
        fail: capability(async () => {
          throw expected;
        }, 100),
      },
      onEvent(event) {
        events.push(event);
      },
    });

    await expect(
      engine.invoke("fail", { value: "safe" }, { signal }),
    ).rejects.toBe(expected);
    expect(overriddenRemove).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual([
      "invocation.started",
      "invocation.failed",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "invocation.failed",
      code: "EXECUTION_FAILED",
    });
  });

  it("contains structural signal teardown failures without changing success", async () => {
    const privateFailure = new Error("private structural signal failure");
    const removeEventListener = vi.fn(() => {
      throw privateFailure;
    });
    const structuralSignal = {
      aborted: false,
      addEventListener() {},
      removeEventListener,
    } as unknown as AbortSignal;
    const events: EngineEvent[] = [];
    const run = vi.fn(async ({ input: value }) => ({ result: value.value }));
    const engine = createEngine({
      name: "structural-signal-engine",
      version: "0.1.0",
      capabilities: { echo: capability(run, 100) },
      onEvent(event) {
        events.push(event);
      },
    });

    await expect(
      engine.invoke("echo", { value: "safe" }, { signal: structuralSignal }),
    ).resolves.toEqual({ result: "safe" });
    expect(run).toHaveBeenCalledOnce();
    expect(removeEventListener).toHaveBeenCalledOnce();
    expect(events.map((event) => event.type)).toEqual([
      "invocation.started",
      "invocation.completed",
    ]);
  });

  it("normalizes structural signal setup failures before running", async () => {
    const privateFailure = new Error("private signal listener failure");
    let registeredListener: (() => void) | undefined;
    const removeEventListener = vi.fn();
    const structuralSignal = {
      aborted: false,
      addEventListener(_type: string, listener: () => void) {
        registeredListener = listener;
        throw privateFailure;
      },
      removeEventListener,
    } as unknown as AbortSignal;
    const events: EngineEvent[] = [];
    const run = vi.fn(async ({ input: value }) => ({ result: value.value }));
    const engine = createEngine({
      name: "structural-signal-setup-engine",
      version: "0.1.0",
      capabilities: { echo: capability(run, 100) },
      onEvent(event) {
        events.push(event);
      },
    });

    const error = await engine
      .invoke("echo", { value: "safe" }, { signal: structuralSignal })
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      code: "EXECUTION_FAILED",
      message: "Capability execution failed.",
    });
    expect(error).not.toBe(privateFailure);
    expect(run).not.toHaveBeenCalled();
    expect(registeredListener).toBeTypeOf("function");
    expect(removeEventListener).toHaveBeenCalledOnce();
    expect(removeEventListener).toHaveBeenCalledWith(
      "abort",
      registeredListener,
    );
    expect(events.map((event) => event.type)).toEqual([
      "invocation.started",
      "invocation.failed",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "invocation.failed",
      code: "EXECUTION_FAILED",
    });
  });

  it.each([
    [
      "aborted state",
      (injected: EngineError) =>
        Object.defineProperty({}, "aborted", {
          get() {
            throw injected;
          },
        }),
    ],
    [
      "abort listener registration",
      (injected: EngineError) => ({
        aborted: false,
        addEventListener() {
          throw injected;
        },
        removeEventListener() {},
      }),
    ],
    [
      "abort reason",
      (injected: EngineError) => ({
        aborted: true,
        get reason() {
          throw injected;
        },
        addEventListener() {},
        removeEventListener() {},
      }),
    ],
  ])(
    "does not let a structural signal %s failure select a public error",
    async (_case, createStructuralSignal) => {
      const injected = new EngineError({
        code: "FORBIDDEN",
        message: "Attacker-selected structural signal failure.",
        publicDetails: { secret: "must-not-escape" },
      });
      const events: EngineEvent[] = [];
      const run = vi.fn(async ({ input: value }) => ({ result: value.value }));
      const engine = createEngine({
        name: "signal-setup-provenance-engine",
        version: "0.1.0",
        capabilities: { echo: capability(run, 100) },
        onEvent(event) {
          events.push(event);
        },
      });

      const error = await engine
        .invoke(
          "echo",
          { value: "safe" },
          {
            signal: createStructuralSignal(injected) as AbortSignal,
          },
        )
        .catch((cause: unknown) => cause);

      expect(error).toMatchObject({
        code: "EXECUTION_FAILED",
        message: "Capability execution failed.",
      });
      expect(error).not.toBe(injected);
      expect((error as EngineError).publicDetails).toBeUndefined();
      expect((error as EngineError).message).not.toContain("Attacker-selected");
      expect(run).not.toHaveBeenCalled();
      expect(events.map((event) => event.type)).toEqual([
        "invocation.started",
        "invocation.failed",
      ]);
      expect(events.at(-1)).toMatchObject({
        type: "invocation.failed",
        code: "EXECUTION_FAILED",
      });
    },
  );

  it("sanitizes a structural signal reason failure after execution starts", async () => {
    const injected = new EngineError({
      code: "FORBIDDEN",
      message: "Attacker-selected asynchronous signal failure.",
      publicDetails: { secret: "must-not-escape" },
    });
    let aborted = false;
    let abortListener: (() => void) | undefined;
    const structuralSignal = {
      get aborted() {
        return aborted;
      },
      get reason() {
        throw injected;
      },
      addEventListener(_type: string, listener: () => void) {
        abortListener = listener;
      },
      removeEventListener() {},
    } as unknown as AbortSignal;
    const executionStarted = Promise.withResolvers<void>();
    const events: EngineEvent[] = [];
    const run = vi.fn(async () => {
      executionStarted.resolve();
      return new Promise<{ result: string }>(() => undefined);
    });
    const engine = createEngine({
      name: "asynchronous-signal-provenance-engine",
      version: "0.1.0",
      capabilities: { echo: capability(run, 100) },
      onEvent(event) {
        events.push(event);
      },
    });

    const invocation = engine.invoke(
      "echo",
      { value: "safe" },
      { signal: structuralSignal },
    );
    await executionStarted.promise;
    aborted = true;
    abortListener?.();
    const error = await invocation.catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      code: "EXECUTION_FAILED",
      message: "Capability execution failed.",
    });
    expect(error).not.toBe(injected);
    expect((error as EngineError).publicDetails).toBeUndefined();
    expect(run).toHaveBeenCalledOnce();
    expect(events.map((event) => event.type)).toEqual([
      "invocation.started",
      "invocation.failed",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "invocation.failed",
      code: "EXECUTION_FAILED",
    });
  });

  it("validates a caller signal before exposing it to access", async () => {
    const injected = new EngineError({
      code: "FORBIDDEN",
      message: "Attacker-selected access signal failure.",
      publicDetails: { secret: "must-not-escape" },
    });
    const structuralSignal = Object.defineProperty({}, "aborted", {
      get() {
        throw injected;
      },
    }) as AbortSignal;
    const access = vi.fn(
      ({ context }: { context: { signal: AbortSignal } }) => {
        void context.signal.aborted;
        return true;
      },
    );
    const run = vi.fn(async () => ({ result: "unreachable" }));
    const events: EngineEvent[] = [];
    const engine = createEngine({
      name: "access-signal-provenance-engine",
      version: "0.1.0",
      capabilities: {
        echo: defineCapability({
          description: "Validate the signal before authorization.",
          input,
          output,
          access,
          run,
        }),
      },
      onEvent(event) {
        events.push(event);
      },
    });

    const error = await engine
      .invoke("echo", { value: "safe" }, { signal: structuralSignal })
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      code: "EXECUTION_FAILED",
      message: "Capability execution failed.",
    });
    expect(error).not.toBe(injected);
    expect((error as EngineError).publicDetails).toBeUndefined();
    expect(access).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual([
      "invocation.started",
      "invocation.failed",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "invocation.failed",
      code: "EXECUTION_FAILED",
    });
  });

  it("does not run access after signal setup observes a reason failure", async () => {
    const injected = new EngineError({
      code: "FORBIDDEN",
      message: "Attacker-selected pre-access reason failure.",
      publicDetails: { secret: "must-not-escape" },
    });
    const structuralSignal = {
      aborted: true,
      get reason() {
        throw injected;
      },
      addEventListener() {},
      removeEventListener() {},
    } as unknown as AbortSignal;
    const access = vi.fn(() => true);
    const run = vi.fn(async () => ({ result: "unreachable" }));
    const engine = createEngine({
      name: "pre-access-signal-reason-engine",
      version: "0.1.0",
      capabilities: {
        echo: defineCapability({
          description: "Fail before authorization on signal setup errors.",
          input,
          output,
          access,
          run,
        }),
      },
    });

    const error = await engine
      .invoke("echo", { value: "safe" }, { signal: structuralSignal })
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      code: "EXECUTION_FAILED",
      message: "Capability execution failed.",
    });
    expect(error).not.toBe(injected);
    expect((error as EngineError).publicDetails).toBeUndefined();
    expect(access).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("does not let access denial hide a caller signal reason failure", async () => {
    const injected = new EngineError({
      code: "OUTPUT_INVALID",
      message: "Attacker-selected authorization signal failure.",
      publicDetails: { secret: "must-not-escape" },
    });
    let aborted = false;
    let abortListener: (() => void) | undefined;
    const structuralSignal = {
      get aborted() {
        return aborted;
      },
      get reason() {
        throw injected;
      },
      addEventListener(_type: string, listener: () => void) {
        abortListener = listener;
      },
      removeEventListener() {},
    } as unknown as AbortSignal;
    const accessStarted = Promise.withResolvers<void>();
    const continueAccess = Promise.withResolvers<void>();
    const access = vi.fn(async () => {
      accessStarted.resolve();
      await continueAccess.promise;
      return false;
    });
    const run = vi.fn(async () => ({ result: "unreachable" }));
    const events: EngineEvent[] = [];
    const engine = createEngine({
      name: "access-signal-reason-engine",
      version: "0.1.0",
      capabilities: {
        echo: defineCapability({
          description: "Preserve caller signal failure provenance.",
          input,
          output,
          access,
          run,
        }),
      },
      onEvent(event) {
        events.push(event);
      },
    });

    const invocation = engine.invoke(
      "echo",
      { value: "safe" },
      { signal: structuralSignal },
    );
    await accessStarted.promise;
    aborted = true;
    abortListener?.();
    continueAccess.resolve();
    const error = await invocation.catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      code: "EXECUTION_FAILED",
      message: "Capability execution failed.",
    });
    expect(error).not.toBe(injected);
    expect((error as EngineError).publicDetails).toBeUndefined();
    expect(access).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({
      type: "invocation.failed",
      code: "EXECUTION_FAILED",
    });
  });

  it("does not let a captured signal failure marker alter later cancellation", async () => {
    const injected = new EngineError({
      code: "FORBIDDEN",
      message: "Private structural signal failure.",
    });
    let aborted = false;
    let callerAbortListener: (() => void) | undefined;
    const structuralSignal = {
      get aborted() {
        return aborted;
      },
      get reason() {
        throw injected;
      },
      addEventListener(_type: string, listener: () => void) {
        callerAbortListener = listener;
      },
      removeEventListener() {},
    } as unknown as AbortSignal;
    const executionStarted = Promise.withResolvers<void>();
    let capturedReason: unknown;
    const captureRun = vi.fn(
      async ({ context }: { context: { signal: AbortSignal } }) => {
        context.signal.addEventListener(
          "abort",
          () => {
            capturedReason = context.signal.reason;
          },
          { once: true },
        );
        executionStarted.resolve();
        return new Promise<{ result: string }>(() => undefined);
      },
    );
    const replayRun = vi.fn(async () => ({ result: "unreachable" }));
    const engine = createEngine({
      name: "signal-provenance-replay-engine",
      version: "0.1.0",
      capabilities: {
        capture: capability(captureRun),
        replay: capability(replayRun),
      },
    });

    const firstInvocation = engine.invoke(
      "capture",
      { value: "safe" },
      { signal: structuralSignal },
    );
    await executionStarted.promise;
    aborted = true;
    callerAbortListener?.();
    await expect(firstInvocation).rejects.toMatchObject({
      code: "EXECUTION_FAILED",
    });
    expect(capturedReason).toBeDefined();

    const replayController = new AbortController();
    replayController.abort(capturedReason);

    await expect(
      engine.invoke(
        "replay",
        { value: "safe" },
        { signal: replayController.signal },
      ),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(replayRun).not.toHaveBeenCalled();
  });

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
