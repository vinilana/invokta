import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createEngine,
  defineCapability,
  type EngineEvent,
  type EngineLogger,
  type ExecutionContext,
  type ProgressReport,
} from "../src/index.js";

const input = z.object({ value: z.string() });
const output = z.object({ result: z.string() });

function progressEngine(
  run: (context: ExecutionContext) => Promise<void> | void,
  options: {
    readonly timeoutMs?: number;
    readonly logger?: EngineLogger;
    readonly onEvent?: (event: EngineEvent) => void;
    readonly access?: (args: { readonly context: ExecutionContext }) => boolean;
  } = {},
) {
  return createEngine({
    name: "progress-engine",
    version: "0.1.0",
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
    capabilities: {
      work: defineCapability({
        description: "Reports progress while it works.",
        input,
        output,
        access: options.access ?? "public",
        ...(options.timeoutMs === undefined
          ? {}
          : { timeoutMs: options.timeoutMs }),
        async run({ input, context }) {
          await run(context);
          return { result: input.value };
        },
      }),
    },
  });
}

function recordingLogger() {
  return {
    debug: vi.fn<EngineLogger["debug"]>(),
    info: vi.fn<EngineLogger["info"]>(),
    warn: vi.fn<EngineLogger["warn"]>(),
    error: vi.fn<EngineLogger["error"]>(),
  } satisfies EngineLogger;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("capability progress reporting", () => {
  it("delivers frozen, request-owned progress snapshots to onProgress in order", async () => {
    const reported: ProgressReport[] = [];
    const returned: unknown[] = [];
    const update = { progress: 1, total: 4, message: "Rendering image 1." };
    const engine = progressEngine((context) => {
      returned.push(context.reportProgress(update));
      update.progress = 99;
      update.message = "mutated after reporting";
      returned.push(context.reportProgress({ progress: 2 }));
      returned.push(
        context.reportProgress({ progress: 3.5, total: 4, message: "" }),
      );
    });

    await expect(
      engine.invoke(
        "work",
        { value: "done" },
        { onProgress: (report) => void reported.push(report) },
      ),
    ).resolves.toEqual({ result: "done" });

    expect(returned).toEqual([undefined, undefined, undefined]);
    expect(reported).toEqual([
      { progress: 1, total: 4, message: "Rendering image 1." },
      { progress: 2 },
      { progress: 3.5, total: 4, message: "" },
    ]);
    expect(Object.keys(reported[1] ?? {})).toEqual(["progress"]);
    for (const report of reported) {
      expect(Object.isFrozen(report)).toBe(true);
      expect(report).not.toBe(update);
    }
  });

  it("is a safe no-op when the caller has no progress sink", async () => {
    const run = vi.fn((context: ExecutionContext) => {
      expect(typeof context.reportProgress).toBe("function");
      expect(context.reportProgress({ progress: 1, total: 2 })).toBeUndefined();
      expect(
        context.reportProgress(
          Number.NaN as unknown as Parameters<
            ExecutionContext["reportProgress"]
          >[0],
        ),
      ).toBeUndefined();
    });
    const engine = progressEngine(run);

    await expect(engine.invoke("work", { value: "quiet" })).resolves.toEqual({
      result: "quiet",
    });
    expect(run).toHaveBeenCalledOnce();
  });

  it("drops invalid reports without throwing into the capability", async () => {
    const reported: ProgressReport[] = [];
    const hostile = {
      get progress(): number {
        throw new Error("private progress accessor failure");
      },
    };
    const proxy = new Proxy(
      { progress: 1 },
      {
        get() {
          throw new Error("private proxy trap");
        },
      },
    );
    const invalid: unknown[] = [
      undefined,
      null,
      7,
      "1",
      [],
      {},
      hostile,
      proxy,
      { progress: "1" },
      { progress: Number.NaN },
      { progress: Number.POSITIVE_INFINITY },
      { progress: -1 },
      { progress: 1, total: 0 },
      { progress: 1, total: -2 },
      { progress: 1, total: Number.POSITIVE_INFINITY },
      { progress: 1, total: "4" },
      { progress: 1, total: null },
      { progress: 1, message: 42 },
      { progress: 1, message: null },
      { progress: 1, message: "x".repeat(1_025) },
    ];
    const engine = progressEngine((context) => {
      for (const value of invalid) {
        expect(() =>
          context.reportProgress(value as ProgressReport),
        ).not.toThrow();
      }
      context.reportProgress({
        progress: -0,
        total: Number.MIN_VALUE,
        message: "x".repeat(1_024),
      });
    });

    await expect(
      engine.invoke(
        "work",
        { value: "valid" },
        { onProgress: (report) => void reported.push(report) },
      ),
    ).resolves.toEqual({ result: "valid" });

    expect(reported).toEqual([
      { progress: 0, total: Number.MIN_VALUE, message: "x".repeat(1_024) },
    ]);
    expect(Object.is(reported[0]?.progress, -0)).toBe(false);
  });

  it("drops reports whose progress does not increase", async () => {
    const reported: number[] = [];
    const engine = progressEngine((context) => {
      context.reportProgress({ progress: 2, total: 10 });
      context.reportProgress({ progress: 2, message: "same value" });
      context.reportProgress({ progress: 1, total: 10 });
      context.reportProgress({ progress: 2.5 });
      context.reportProgress({ progress: 2.5, total: 20 });
      context.reportProgress({ progress: 10, total: 20 });
    });

    await engine.invoke(
      "work",
      { value: "monotonic" },
      { onProgress: (report) => void reported.push(report.progress) },
    );

    expect(reported).toEqual([2, 2.5, 10]);
  });

  it("contains synchronous and asynchronous onProgress failures", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const logger = recordingLogger();
    const events: EngineEvent["type"][] = [];
    const calls: number[] = [];
    try {
      const engine = progressEngine(
        (context) => {
          context.reportProgress({ progress: 1, message: "private message" });
          context.reportProgress({ progress: 2 });
          context.reportProgress({ progress: 3 });
        },
        { logger, onEvent: (event) => void events.push(event.type) },
      );

      await expect(
        engine.invoke(
          "work",
          { value: "isolated" },
          {
            requestId: "request-progress-failure",
            onProgress(report) {
              calls.push(report.progress);
              if (report.progress === 1) {
                throw new Error("private synchronous sink failure");
              }
              return Promise.reject(
                new Error("private asynchronous sink failure"),
              );
            },
          },
        ),
      ).resolves.toEqual({ result: "isolated" });
      await new Promise((resolve) => setImmediate(resolve));

      expect(calls).toEqual([1, 2, 3]);
      expect(events).toEqual(["invocation.started", "invocation.completed"]);
      expect(logger.error).toHaveBeenCalledExactlyOnceWith(
        "Invocation progress callback failed.",
        { requestId: "request-progress-failure" },
      );
      expect(JSON.stringify(logger.error.mock.calls)).not.toContain("private");
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("contains a failing diagnostic logger after an onProgress failure", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const logger = recordingLogger();
    logger.error.mockImplementation(() => {
      throw new Error("logger unavailable");
    });
    try {
      const engine = progressEngine(
        (context) => {
          context.reportProgress({ progress: 1 });
        },
        { logger },
      );

      await expect(
        engine.invoke(
          "work",
          { value: "logged" },
          {
            onProgress() {
              throw new Error("sink unavailable");
            },
          },
        ),
      ).resolves.toEqual({ result: "logged" });
      await new Promise((resolve) => setImmediate(resolve));

      expect(logger.error).toHaveBeenCalledOnce();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("never waits for a pending onProgress promise", async () => {
    const pending = new Promise<void>(() => undefined);
    const engine = progressEngine((context) => {
      context.reportProgress({ progress: 1 });
    });

    const result = await Promise.race([
      engine.invoke("work", { value: "fast" }, { onProgress: () => pending }),
      new Promise((resolve) => setImmediate(() => resolve("blocked"))),
    ]);

    expect(result).toEqual({ result: "fast" });
  });

  it("reports progress before the terminal event", async () => {
    const order: string[] = [];
    const engine = progressEngine(
      (context) => {
        context.reportProgress({ progress: 1 });
      },
      { onEvent: (event) => void order.push(event.type) },
    );

    await engine.invoke(
      "work",
      { value: "ordered" },
      {
        onProgress: (report) => void order.push(`progress:${report.progress}`),
      },
    );

    expect(order).toEqual([
      "invocation.started",
      "progress:1",
      "invocation.completed",
    ]);
  });

  it("stops delivering once the capability handler has settled", async () => {
    const reported: number[] = [];
    let late!: () => void;
    const lateReport = new Promise<void>((resolve) => {
      late = resolve;
    });
    let captured: ExecutionContext | undefined;
    const engine = progressEngine((context) => {
      captured = context;
      context.reportProgress({ progress: 1 });
    });

    await engine.invoke(
      "work",
      { value: "settled" },
      { onProgress: (report) => void reported.push(report.progress) },
    );
    setImmediate(() => {
      captured?.reportProgress({ progress: 2 });
      late();
    });
    await lateReport;

    expect(reported).toEqual([1]);
  });

  it("stops delivering once the invocation is cancelled", async () => {
    const reported: number[] = [];
    const controller = new AbortController();
    let reportAfterAbort!: () => void;
    const afterAbort = new Promise<void>((resolve) => {
      reportAfterAbort = resolve;
    });
    const engine = progressEngine(async (context) => {
      context.reportProgress({ progress: 1 });
      await new Promise<void>((resolve) => {
        context.signal.addEventListener(
          "abort",
          () => {
            context.reportProgress({ progress: 2 });
            resolve();
          },
          { once: true },
        );
      });
      context.reportProgress({ progress: 3 });
      reportAfterAbort();
    });

    const pending = engine.invoke(
      "work",
      { value: "cancelled" },
      {
        signal: controller.signal,
        onProgress: (report) => void reported.push(report.progress),
      },
    );
    await vi.waitFor(() => expect(reported).toEqual([1]));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    await afterAbort;
    expect(reported).toEqual([1]);
  });

  it("stops delivering once the capability timeout aborts execution", async () => {
    const reported: number[] = [];
    let timedOut!: () => void;
    const afterTimeout = new Promise<void>((resolve) => {
      timedOut = resolve;
    });
    const engine = progressEngine(
      async (context) => {
        context.reportProgress({ progress: 1 });
        await new Promise<void>((resolve) => {
          context.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        context.reportProgress({ progress: 2 });
        timedOut();
      },
      { timeoutMs: 5 },
    );

    await expect(
      engine.invoke(
        "work",
        { value: "slow" },
        { onProgress: (report) => void reported.push(report.progress) },
      ),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    await afterTimeout;

    expect(reported).toEqual([1]);
  });

  it("ignores progress reported by an access rule", async () => {
    const reported: number[] = [];
    const engine = progressEngine(
      (context) => {
        context.reportProgress({ progress: 2 });
      },
      {
        access({ context }) {
          expect(() => context.reportProgress({ progress: 1 })).not.toThrow();
          context.reportProgress({ progress: 5 });
          return true;
        },
      },
    );

    await engine.invoke(
      "work",
      { value: "authorized" },
      { onProgress: (report) => void reported.push(report.progress) },
    );

    expect(reported).toEqual([2]);
  });

  it("does not report progress for a denied invocation", async () => {
    const onProgress = vi.fn();
    const run = vi.fn((context: ExecutionContext) => {
      context.reportProgress({ progress: 1 });
    });
    const engine = progressEngine(run, {
      access({ context }) {
        context.reportProgress({ progress: 1 });
        return false;
      },
    });

    await expect(
      engine.invoke("work", { value: "denied" }, { onProgress }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(run).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("fails closed when the onProgress option is malformed or unreadable", async () => {
    const events: EngineEvent[] = [];
    const run = vi.fn();
    const engine = progressEngine(run, {
      onEvent: (event) => void events.push(event),
    });
    const unreadable = {
      requestId: "caller-request",
      source: "cli",
      get onProgress(): never {
        throw new Error("private option accessor failure");
      },
    };

    await expect(
      engine.invoke("work", { value: "x" }, {
        requestId: "malformed-progress",
        onProgress: "not a function",
      } as never),
    ).rejects.toMatchObject({ code: "EXECUTION_FAILED" });
    await expect(
      engine.invoke("work", { value: "x" }, unreadable as never),
    ).rejects.toMatchObject({
      code: "EXECUTION_FAILED",
      message: "Capability execution failed.",
    });

    expect(run).not.toHaveBeenCalled();
    expect(events.map((event) => [event.type, event.requestId])).toEqual([
      ["invocation.started", expect.not.stringMatching("malformed-progress")],
      ["invocation.failed", expect.not.stringMatching("malformed-progress")],
      ["invocation.started", expect.not.stringMatching("caller-request")],
      ["invocation.failed", expect.not.stringMatching("caller-request")],
    ]);
    expect(
      events.filter((event) => event.type === "invocation.started"),
    ).toEqual([
      expect.objectContaining({ source: "direct" }),
      expect.objectContaining({ source: "direct" }),
    ]);
  });
});
