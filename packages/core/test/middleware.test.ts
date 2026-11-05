import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  type AnyCapability,
  applyMiddleware,
  type CapabilityMiddleware,
  type CapabilityMiddlewareArgs,
  composeCapabilities,
  createEngine,
  defineCapability,
  defineCapabilityLibrary,
  defineExportedCapability,
  EngineError,
  type EngineErrorCode,
  type EngineEvent,
  type ExecutionContext,
  importCapabilities,
  importCapability,
  isComposedCapabilities,
} from "../src/index.js";

const ticketInput = z.object({
  ticketId: z.string().min(1),
  tags: z.array(z.string()).default([]),
});
const ticketOutput = z.object({
  category: z.string(),
  priority: z.number().int().default(3),
});

type TicketRun = (args: {
  readonly input: z.output<typeof ticketInput>;
  readonly context: ExecutionContext;
}) => Promise<z.input<typeof ticketOutput>>;

function classifyCapability(
  run: TicketRun = async ({ input }) => ({
    category: `billing:${input.ticketId}`,
  }),
  overrides: Partial<Omit<AnyCapability, "run">> = {},
): AnyCapability {
  return {
    ...defineCapability({
      title: "Classify ticket",
      description: "Classify a support ticket.",
      input: ticketInput,
      output: ticketOutput,
      access: "public",
      timeoutMs: 1_000,
      annotations: { readOnly: true, idempotent: true },
      run,
    }),
    ...overrides,
  } as AnyCapability;
}

function engineFor(
  capabilities: Readonly<Record<string, AnyCapability>>,
  events?: EngineEvent[],
) {
  return createEngine({
    name: "middleware-engine",
    version: "1.0.0",
    capabilities,
    ...(events === undefined
      ? {}
      : {
          onEvent(event: EngineEvent) {
            events.push(event);
          },
        }),
  });
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

function trace(steps: string[], name: string): CapabilityMiddleware {
  return async ({ next }) => {
    steps.push(`${name}:before`);
    const output = await next();
    steps.push(`${name}:after`);
    return output;
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs the work and then waits long enough for Node to report any promise
 * rejection that nothing handled.
 */
async function unhandledRejectionsDuring(
  work: () => Promise<void>,
): Promise<unknown[]> {
  const reasons: unknown[] = [];
  const record = (reason: unknown): void => {
    reasons.push(reason);
  };
  process.on("unhandledRejection", record);
  try {
    await work();
    await delay(20);
  } finally {
    process.off("unhandledRejection", record);
  }
  return reasons;
}

describe("applyMiddleware execution order", () => {
  it("runs the first listed middleware outermost and the handler innermost", async () => {
    const steps: string[] = [];
    const capabilities = applyMiddleware(
      {
        "support.classify": classifyCapability(async ({ input }) => {
          steps.push("run");
          return { category: input.ticketId };
        }),
      },
      trace(steps, "outer"),
      trace(steps, "middle"),
      trace(steps, "inner"),
    );

    await expect(
      engineFor(capabilities).invoke("support.classify", { ticketId: "T-1" }),
    ).resolves.toEqual({ category: "T-1", priority: 3 });
    expect(steps).toEqual([
      "outer:before",
      "middle:before",
      "inner:before",
      "run",
      "inner:after",
      "middle:after",
      "outer:after",
    ]);
  });

  it("wraps an earlier application from outside when applied again", async () => {
    const steps: string[] = [];
    const inner = applyMiddleware(
      {
        "support.classify": classifyCapability(async ({ input }) => {
          steps.push("run");
          return { category: input.ticketId };
        }),
      },
      trace(steps, "first-application"),
    );
    const outer = applyMiddleware(inner, trace(steps, "second-application"));

    await engineFor(outer).invoke("support.classify", { ticketId: "T-1" });
    expect(steps).toEqual([
      "second-application:before",
      "first-application:before",
      "run",
      "first-application:after",
      "second-application:after",
    ]);
  });

  it("applies the same chain independently to every capability in the map", async () => {
    const observed: string[] = [];
    const capabilities = applyMiddleware(
      {
        "support.classify": classifyCapability(),
        "support.route": classifyCapability(async () => ({
          category: "route",
        })),
      },
      async ({ capabilityId, next }) => {
        observed.push(capabilityId);
        return next();
      },
    );
    const engine = engineFor(capabilities);

    await engine.invoke("support.route", { ticketId: "T-1" });
    await engine.invoke("support.classify", { ticketId: "T-2" });
    expect(observed).toEqual(["support.route", "support.classify"]);
  });
});

describe("applyMiddleware arguments", () => {
  it("passes the capability ID, the validated input, and the unchanged execution context", async () => {
    let middlewareArgs: CapabilityMiddlewareArgs | undefined;
    let runContext: ExecutionContext | undefined;
    const capabilities = applyMiddleware(
      {
        "support.classify": classifyCapability(async ({ input, context }) => {
          runContext = context;
          return { category: input.ticketId };
        }),
      },
      async (args) => {
        middlewareArgs = args;
        return args.next();
      },
    );

    await engineFor(capabilities).invoke(
      "support.classify",
      { ticketId: "T-1" },
      {
        requestId: "request-1",
        source: "cli",
        principal: { id: "user:1", attributes: { team: "billing" } },
      },
    );

    expect(middlewareArgs?.capabilityId).toBe("support.classify");
    expect(middlewareArgs?.input).toEqual({ ticketId: "T-1", tags: [] });
    expect(middlewareArgs?.context).toBe(runContext);
    expect(middlewareArgs?.context).toMatchObject({
      requestId: "request-1",
      source: "cli",
      principal: { id: "user:1", attributes: { team: "billing" } },
    });
    expect(Object.isFrozen(middlewareArgs)).toBe(true);
  });

  it("gives middleware a frozen input snapshot that cannot change what run receives", async () => {
    let runInput: unknown;
    let mutationError: unknown;
    let middlewareInput: unknown;
    const capabilities = applyMiddleware(
      {
        "support.classify": classifyCapability(async ({ input }) => {
          runInput = input;
          return { category: input.ticketId };
        }),
      },
      async ({ input, next }) => {
        middlewareInput = input;
        try {
          (input as { ticketId: string }).ticketId = "T-forged";
        } catch (error) {
          mutationError = error;
        }
        try {
          (input as { tags: string[] }).tags.push("forged");
        } catch {
          // The nested snapshot is frozen as well.
        }
        return next();
      },
    );

    await expect(
      engineFor(capabilities).invoke("support.classify", { ticketId: "T-1" }),
    ).resolves.toEqual({ category: "T-1", priority: 3 });

    expect(mutationError).toBeInstanceOf(TypeError);
    expect(Object.isFrozen(middlewareInput)).toBe(true);
    expect(Object.isFrozen((middlewareInput as { tags: string[] }).tags)).toBe(
      true,
    );
    expect(middlewareInput).not.toBe(runInput);
    expect(runInput).toEqual({ ticketId: "T-1", tags: [] });
    expect(Object.isFrozen(runInput)).toBe(false);
  });
  it("snapshots the input lazily, once per invocation, across layers and nested applications", async () => {
    const clone = vi.spyOn(globalThis, "structuredClone");
    const clonesPerInvocation = async (
      capabilities: Readonly<Record<string, AnyCapability>>,
    ): Promise<number> => {
      const engine = engineFor(capabilities);
      clone.mockClear();
      await engine.invoke("support.classify", { ticketId: "T-1" });
      return clone.mock.calls.length;
    };
    const passThrough: CapabilityMiddleware = async ({ next }) => next();
    const seen: unknown[] = [];
    const reading: CapabilityMiddleware = async ({ input, next }) => {
      seen.push(input);
      return next();
    };

    try {
      const unwrapped = await clonesPerInvocation({
        "support.classify": classifyCapability(),
      });
      await expect(
        clonesPerInvocation(
          applyMiddleware(
            applyMiddleware(
              { "support.classify": classifyCapability() },
              passThrough,
            ),
            passThrough,
            passThrough,
          ),
        ),
      ).resolves.toBe(unwrapped);
      await expect(
        clonesPerInvocation(
          applyMiddleware(
            applyMiddleware(
              { "support.classify": classifyCapability() },
              reading,
              reading,
            ),
            reading,
          ),
        ),
      ).resolves.toBe(unwrapped + 1);
    } finally {
      clone.mockRestore();
    }

    expect(seen).toHaveLength(3);
    expect(seen[1]).toBe(seen[0]);
    expect(seen[2]).toBe(seen[0]);
    expect(Object.isFrozen(seen[0])).toBe(true);
  });

  it("accepts the same direct-call input as the unwrapped run until middleware reads it", async () => {
    const at = new Date(0);
    let received: unknown;
    const capabilities = applyMiddleware(
      {
        "support.classify": classifyCapability(async ({ input }) => {
          received = input;
          return { category: "direct" };
        }),
      },
      async ({ next }) => next(),
    );
    const wrapped = capabilities["support.classify"] as AnyCapability;
    const input = { ticketId: "T-1", tags: [], at };

    await expect(
      (wrapped.run as unknown as TicketRun)({
        input,
        context: {
          requestId: "request-1",
          source: "direct",
          principal: null,
          signal: new AbortController().signal,
          logger: console,
        },
      }),
    ).resolves.toEqual({ category: "direct" });
    expect(received).toBe(input);
  });
});

describe("applyMiddleware pipeline guarantees", () => {
  it("validates input before the chain and never calls middleware for invalid input", async () => {
    const middleware = vi.fn<CapabilityMiddleware>(async ({ next }) => next());
    const run = vi.fn<TicketRun>(async () => ({ category: "never" }));
    const capabilities = applyMiddleware(
      { "support.classify": classifyCapability(run) },
      middleware,
    );

    await expectEngineError(
      engineFor(capabilities).invoke("support.classify", { ticketId: "" }),
      "INPUT_INVALID",
    );
    expect(middleware).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("enforces access before any middleware runs", async () => {
    const steps: string[] = [];
    const middleware = vi.fn<CapabilityMiddleware>(async ({ next }) => {
      steps.push("middleware");
      return next();
    });
    const capabilities = applyMiddleware(
      {
        "support.authenticated": classifyCapability(undefined, {
          access: "authenticated",
        }),
        "support.denied": classifyCapability(undefined, {
          access: (() => {
            steps.push("access");
            return false;
          }) as AnyCapability["access"],
        }),
        "support.allowed": classifyCapability(undefined, {
          access: (() => {
            steps.push("access");
            return true;
          }) as AnyCapability["access"],
        }),
      },
      middleware,
    );
    const engine = engineFor(capabilities);

    await expectEngineError(
      engine.invoke("support.authenticated", { ticketId: "T-1" }),
      "UNAUTHENTICATED",
    );
    await expectEngineError(
      engine.invoke(
        "support.denied",
        { ticketId: "T-1" },
        { principal: { id: "user:1" } },
      ),
      "FORBIDDEN",
    );
    expect(middleware).not.toHaveBeenCalled();

    await engine.invoke(
      "support.allowed",
      { ticketId: "T-1" },
      { principal: { id: "user:1" } },
    );
    expect(steps).toEqual(["access", "access", "middleware"]);
  });

  it("validates and transforms the chain's final result against the output schema", async () => {
    const run = vi.fn<TicketRun>(async () => ({ category: "from-run" }));
    const replacing = applyMiddleware(
      { "support.classify": classifyCapability(run) },
      async () => ({ category: "from-middleware" }),
    );
    const invalid = applyMiddleware(
      { "support.classify": classifyCapability(run) },
      async ({ next }) => {
        await next();
        return { category: 42 };
      },
    );
    await expect(
      engineFor(replacing).invoke("support.classify", { ticketId: "T-1" }),
    ).resolves.toEqual({ category: "from-middleware", priority: 3 });
    expect(run).not.toHaveBeenCalled();

    await expectEngineError(
      engineFor(invalid).invoke("support.classify", { ticketId: "T-1" }),
      "OUTPUT_INVALID",
    );
    expect(run).toHaveBeenCalledOnce();

    const passthroughOutput = z.object({ category: z.string() }).passthrough();
    await expectEngineError(
      engineFor(
        applyMiddleware(
          {
            "support.classify": classifyCapability(run, {
              output: passthroughOutput,
            }),
          },
          async () => ({ category: "x", extra: () => undefined }),
        ),
      ).invoke("support.classify", { ticketId: "T-1" }),
      "OUTPUT_INVALID",
    );
  });

  it("normalizes middleware failures exactly like failures thrown by run", async () => {
    const privateFailure = new Error("private middleware failure detail");
    const publicFailure = new EngineError({
      code: "EXECUTION_FAILED",
      message: "Upstream quota exhausted.",
      publicDetails: { reason: "QUOTA" },
    });
    const outcomes = async (
      failure: unknown,
      synchronous = false,
    ): Promise<{
      readonly fromRun: EngineError;
      readonly fromMiddleware: EngineError;
      readonly events: readonly EngineEvent[];
    }> => {
      const runEvents: EngineEvent[] = [];
      const middlewareEvents: EngineEvent[] = [];
      const fromRun = await expectEngineError(
        engineFor(
          {
            "support.classify": classifyCapability(async () => {
              throw failure;
            }),
          },
          runEvents,
        ).invoke("support.classify", { ticketId: "T-1" }),
        "EXECUTION_FAILED",
      );
      const throwing = (() => {
        throw failure;
      }) as unknown as CapabilityMiddleware;
      const fromMiddleware = await expectEngineError(
        engineFor(
          applyMiddleware(
            { "support.classify": classifyCapability() },
            synchronous
              ? throwing
              : async () => {
                  throw failure;
                },
          ),
          middlewareEvents,
        ).invoke("support.classify", { ticketId: "T-1" }),
        "EXECUTION_FAILED",
      );
      expect(
        middlewareEvents.map(({ type }) => type),
        "middleware events",
      ).toEqual(runEvents.map(({ type }) => type));
      return { fromRun, fromMiddleware, events: middlewareEvents };
    };

    const unknown = await outcomes(privateFailure);
    expect(unknown.fromMiddleware.message).toBe(unknown.fromRun.message);
    expect(unknown.fromMiddleware.message).toBe("Capability execution failed.");
    expect(unknown.fromMiddleware.publicDetails).toBeUndefined();
    expect(unknown.fromMiddleware.cause).toBe(privateFailure);
    expect(unknown.events.at(-1)).toMatchObject({
      type: "invocation.failed",
      code: "EXECUTION_FAILED",
    });

    const synchronous = await outcomes(privateFailure, true);
    expect(synchronous.fromMiddleware.message).toBe(
      "Capability execution failed.",
    );
    expect(synchronous.fromMiddleware.cause).toBe(privateFailure);

    const stable = await outcomes(publicFailure);
    expect(stable.fromMiddleware).toBe(publicFailure);
    expect(stable.fromRun).toBe(publicFailure);
  });

  it("delivers caller cancellation to waiting middleware through context.signal", async () => {
    const controller = new AbortController();
    const run = vi.fn<TicketRun>(async () => ({ category: "never" }));
    let observedAbort: (() => void) | undefined;
    const aborted = new Promise<void>((resolve) => {
      observedAbort = resolve;
    });
    let started: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const capabilities = applyMiddleware(
      { "support.classify": classifyCapability(run) },
      async ({ context, next }) => {
        context.signal.addEventListener("abort", () => observedAbort?.(), {
          once: true,
        });
        started?.();
        await aborted;
        return next();
      },
    );

    const invocation = engineFor(capabilities).invoke(
      "support.classify",
      { ticketId: "T-1" },
      { signal: controller.signal },
    );
    await waiting;
    controller.abort(new Error("caller stopped"));

    await expectEngineError(invocation, "CANCELLED");
    await aborted;
    await new Promise((resolve) => setImmediate(resolve));
    expect(run).not.toHaveBeenCalled();
  });

  it("applies the capability timeout to the whole middleware chain", async () => {
    const run = vi.fn<TicketRun>(async () => ({ category: "never" }));
    let middlewareSignal: AbortSignal | undefined;
    const capabilities = applyMiddleware(
      {
        "support.classify": classifyCapability(run, { timeoutMs: 5 }),
      },
      async ({ context, next }) => {
        middlewareSignal = context.signal;
        await new Promise<void>((resolve) => {
          context.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        return next();
      },
    );

    const error = await expectEngineError(
      engineFor(capabilities).invoke("support.classify", { ticketId: "T-1" }),
      "CANCELLED",
    );
    expect(error.message).toBe("Capability invocation was cancelled.");
    expect(middlewareSignal?.aborted).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(run).not.toHaveBeenCalled();
  });
});

describe("applyMiddleware next()", () => {
  it("rejects a second next() call and executes the handler only once", async () => {
    const run = vi.fn<TicketRun>(async ({ input }) => ({
      category: input.ticketId,
    }));
    let secondCall: unknown;
    const capabilities = applyMiddleware(
      { "support.classify": classifyCapability(run) },
      async ({ next }) => {
        const output = await next();
        try {
          await next();
        } catch (error) {
          secondCall = error;
        }
        return output;
      },
    );

    await expect(
      engineFor(capabilities).invoke("support.classify", { ticketId: "T-1" }),
    ).resolves.toEqual({ category: "T-1", priority: 3 });
    expect(run).toHaveBeenCalledOnce();
    expect(secondCall).toBeInstanceOf(TypeError);
    expect((secondCall as TypeError).message).toBe(
      "Capability middleware called next() more than once.",
    );
  });

  it("fails the invocation as EXECUTION_FAILED when a repeated next() rejection propagates", async () => {
    const run = vi.fn<TicketRun>(async ({ input }) => ({
      category: input.ticketId,
    }));
    const capabilities = applyMiddleware(
      { "support.classify": classifyCapability(run) },
      async ({ next }) => {
        await next();
        return next();
      },
    );

    const error = await expectEngineError(
      engineFor(capabilities).invoke("support.classify", { ticketId: "T-1" }),
      "EXECUTION_FAILED",
    );
    expect(error.message).toBe("Capability execution failed.");
    expect(error.cause).toBeInstanceOf(TypeError);
    expect(run).toHaveBeenCalledOnce();
  });

  it("treats a re-entrant next() from the next layer as a repeated call", async () => {
    let storedNext: (() => Promise<unknown>) | undefined;
    let reentrant: Promise<unknown> | undefined;
    const run = vi.fn<TicketRun>(async ({ input }) => {
      // The synchronous start of run re-enters the outer middleware's next().
      reentrant = storedNext?.();
      return { category: input.ticketId };
    });
    const capabilities = applyMiddleware(
      { "support.classify": classifyCapability(run) },
      async ({ next }) => {
        storedNext = next;
        return next();
      },
    );

    await expect(
      engineFor(capabilities).invoke("support.classify", { ticketId: "T-1" }),
    ).resolves.toEqual({ category: "T-1", priority: 3 });
    expect(run).toHaveBeenCalledOnce();
    await expect(reentrant).rejects.toThrow(
      new TypeError("Capability middleware called next() more than once."),
    );
  });

  it("rejects next() after the middleware has settled without running the handler", async () => {
    const run = vi.fn<TicketRun>(async () => ({ category: "late" }));
    let lateNext: (() => Promise<unknown>) | undefined;
    const capabilities = applyMiddleware(
      { "support.classify": classifyCapability(run) },
      async ({ next }) => {
        lateNext = next;
        return { category: "short-circuit" };
      },
    );

    await expect(
      engineFor(capabilities).invoke("support.classify", { ticketId: "T-1" }),
    ).resolves.toEqual({ category: "short-circuit", priority: 3 });
    await expect(lateNext?.()).rejects.toThrow(
      new TypeError("Capability middleware called next() after it settled."),
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("does not start the next layer once the invocation signal is aborted", async () => {
    const controller = new AbortController();
    const reason = new Error("caller stopped");
    const inner = vi.fn<CapabilityMiddleware>(async ({ next }) => next());
    const run = vi.fn<TicketRun>(async () => ({ category: "never" }));
    let nextOutcome: Promise<unknown> | undefined;
    let release: (() => void) | undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const capabilities = applyMiddleware(
      { "support.classify": classifyCapability(run) },
      async ({ next }) => {
        controller.abort(reason);
        nextOutcome = next();
        release?.();
        return nextOutcome;
      },
      inner,
    );

    await expectEngineError(
      engineFor(capabilities).invoke(
        "support.classify",
        { ticketId: "T-1" },
        { signal: controller.signal },
      ),
      "CANCELLED",
    );
    await released;
    await expect(nextOutcome).rejects.toBe(reason);
    expect(inner).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps a started layer inside the timeout when a middleware returns without awaiting next()", async () => {
    const steps: string[] = [];
    const run = vi.fn<TicketRun>(async () => {
      steps.push("run");
      return { category: "detached" };
    });
    let innerSignal: AbortSignal | undefined;
    let innerNext: Promise<unknown> | undefined;
    const capabilities = applyMiddleware(
      { "support.classify": classifyCapability(run, { timeoutMs: 10 }) },
      async ({ next }) => {
        void next();
        return { category: "outer" };
      },
      async ({ context, next }) => {
        innerSignal = context.signal;
        await delay(50);
        innerNext = next();
        return innerNext;
      },
    );
    const engine = engineFor(capabilities);

    await expectEngineError(
      engine.invoke("support.classify", { ticketId: "T-1" }),
      "CANCELLED",
    );
    await delay(80);
    expect(innerSignal?.aborted).toBe(true);
    await expect(innerNext).rejects.toBeInstanceOf(Error);
    expect(run).not.toHaveBeenCalled();
    expect(steps).toEqual([]);
  });

  it("settles the invocation only after every started layer settles", async () => {
    const steps: string[] = [];
    let releaseRun: (() => void) | undefined;
    const runReleased = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const capabilities = applyMiddleware(
      {
        "support.classify": classifyCapability(async () => {
          steps.push("run:started");
          await runReleased;
          steps.push("run:settled");
          return { category: "from-run" };
        }),
      },
      async ({ next }) => {
        void next();
        steps.push("outer:returned");
        return { category: "outer" };
      },
    );

    const invocation = engineFor(capabilities)
      .invoke("support.classify", { ticketId: "T-1" })
      .then((output) => {
        steps.push("invocation:settled");
        return output;
      });
    await delay(10);
    expect(steps).toEqual(["run:started", "outer:returned"]);

    releaseRun?.();
    await expect(invocation).resolves.toEqual({
      category: "outer",
      priority: 3,
    });
    expect(steps).toEqual([
      "run:started",
      "outer:returned",
      "run:settled",
      "invocation:settled",
    ]);
  });

  it("ignores and contains the failure of a layer the middleware did not await", async () => {
    const privateFailure = new Error("detached handler failure");
    const reasons = await unhandledRejectionsDuring(async () => {
      const capabilities = applyMiddleware(
        {
          "support.classify": classifyCapability(async () => {
            throw privateFailure;
          }),
        },
        async ({ next }) => {
          void next();
          return { category: "outer" };
        },
      );

      await expect(
        engineFor(capabilities).invoke("support.classify", {
          ticketId: "T-1",
        }),
      ).resolves.toEqual({ category: "outer", priority: 3 });
    });

    expect(reasons).toEqual([]);
  });

  it("contains rejected next() promises that a middleware never awaits", async () => {
    const run = vi.fn<TicketRun>(async ({ input }) => ({
      category: input.ticketId,
    }));
    const controller = new AbortController();
    const reasons = await unhandledRejectionsDuring(async () => {
      const repeated = applyMiddleware(
        { "support.classify": classifyCapability(run) },
        async ({ next }) => {
          const output = await next();
          void next();
          return output;
        },
      );
      await expect(
        engineFor(repeated).invoke("support.classify", { ticketId: "T-1" }),
      ).resolves.toEqual({ category: "T-1", priority: 3 });

      const afterAbort = applyMiddleware(
        { "support.classify": classifyCapability(run) },
        async ({ next }) => {
          controller.abort(new Error("caller stopped"));
          void next();
          await delay(5);
          return { category: "aborted" };
        },
      );
      await expectEngineError(
        engineFor(afterAbort).invoke(
          "support.classify",
          { ticketId: "T-1" },
          { signal: controller.signal },
        ),
        "CANCELLED",
      );
    });

    expect(reasons).toEqual([]);
    expect(run).toHaveBeenCalledOnce();
  });

  it("requires a platform AbortSignal when run is called outside the engine", async () => {
    const run = vi.fn<TicketRun>(async () => ({ category: "never" }));
    const capabilities = applyMiddleware(
      { "support.classify": classifyCapability(run) },
      async ({ next }) => next(),
    );
    const wrapped = capabilities["support.classify"] as AnyCapability;
    const forgedSignal = { aborted: false } as unknown as AbortSignal;

    await expect(
      (wrapped.run as unknown as TicketRun)({
        input: { ticketId: "T-1", tags: [] },
        context: {
          requestId: "request-1",
          source: "direct",
          principal: null,
          signal: forgedSignal,
          logger: console,
        },
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("applyMiddleware capability contract", () => {
  it("keeps every contract field by identity and replaces only run", () => {
    const access = vi.fn(() => true);
    const original = {
      ...classifyCapability(undefined, {
        access: access as unknown as AnyCapability["access"],
      }),
      deprecated: { since: "1.2.0" },
    } as AnyCapability & { readonly deprecated: { since: string } };
    const capabilities = applyMiddleware(
      { "support.classify": original },
      async ({ next }) => next(),
    );
    const wrapped = capabilities["support.classify"] as typeof original;

    expect(wrapped).not.toBe(original);
    expect(wrapped.title).toBe(original.title);
    expect(wrapped.description).toBe(original.description);
    expect(wrapped.input).toBe(original.input);
    expect(wrapped.output).toBe(original.output);
    expect(wrapped.access).toBe(access);
    expect(wrapped.timeoutMs).toBe(original.timeoutMs);
    expect(wrapped.annotations).toBe(original.annotations);
    expect(wrapped.deprecated).toBe(original.deprecated);
    expect(wrapped.run).not.toBe(original.run);
    expect(Object.keys(wrapped).sort()).toEqual(Object.keys(original).sort());
    expect(Object.isFrozen(wrapped)).toBe(true);
    expect(Object.isFrozen(capabilities)).toBe(true);
    expect(access).not.toHaveBeenCalled();
  });

  it("keeps every own property and the inherited contract fields by identity", () => {
    const ownMarker = Symbol("capability.own");
    const inheritedMarker = Symbol("capability.inherited");
    const base = {
      errors: { TICKET_NOT_FOUND: { message: "Ticket not found." } },
      deprecated: { since: "1.2.0" },
      inheritedHelper: "not part of the capability contract",
      [inheritedMarker]: true,
    };
    const original = Object.create(base, {
      ...Object.getOwnPropertyDescriptors(classifyCapability()),
      stability: { value: "experimental", enumerable: false },
      [ownMarker]: { value: "symbol-field", enumerable: true },
    }) as AnyCapability;
    const wrapped = applyMiddleware(
      { "support.classify": original },
      async ({ next }) => next(),
    )["support.classify"] as AnyCapability;
    const read = (value: object, key: PropertyKey): unknown =>
      Reflect.get(value, key);

    for (const key of Reflect.ownKeys(original)) {
      if (key === "run") continue;
      expect(read(wrapped, key), String(key)).toBe(read(original, key));
    }
    for (const key of ["errors", "deprecated"]) {
      expect(Object.hasOwn(wrapped, key), key).toBe(true);
      expect(read(wrapped, key), key).toBe(read(original, key));
    }
    expect(Object.getOwnPropertyDescriptor(wrapped, "stability")).toMatchObject(
      { value: "experimental", enumerable: false },
    );
    expect(Reflect.has(wrapped, "inheritedHelper")).toBe(false);
    expect(Reflect.has(wrapped, inheritedMarker)).toBe(false);
    expect(
      engineFor({ "support.classify": wrapped }).describe("support.classify"),
    ).toEqual(
      engineFor({ "support.classify": original }).describe("support.classify"),
    );
  });

  it("wraps a class instance without invoking or flattening unrelated members", async () => {
    let clientReads = 0;
    class ClassifyTicket {
      readonly description = "Classify a support ticket.";
      readonly input = ticketInput;
      readonly output = ticketOutput;
      readonly access = "public";

      get title(): string {
        return "Classify ticket";
      }

      get client(): never {
        clientReads += 1;
        throw new Error("client not configured yet");
      }

      helper(): string {
        return "helper";
      }

      async run({ input }: { readonly input: { ticketId: string } }) {
        return { category: input.ticketId };
      }
    }
    const instance = new ClassifyTicket() as unknown as AnyCapability;
    const unwrapped = engineFor({ "support.classify": instance });
    const wrapped = applyMiddleware(
      { "support.classify": instance },
      async ({ next }) => next(),
    )["support.classify"] as AnyCapability;

    expect(clientReads).toBe(0);
    expect(Object.getOwnPropertyDescriptor(wrapped, "title")).toMatchObject({
      value: "Classify ticket",
    });
    expect(Object.hasOwn(wrapped, "constructor")).toBe(false);
    expect(Reflect.has(wrapped, "client")).toBe(false);
    expect(Reflect.has(wrapped, "helper")).toBe(false);

    const engine = engineFor({ "support.classify": wrapped });
    expect(engine.describe("support.classify")).toEqual(
      unwrapped.describe("support.classify"),
    );
    await expect(
      engine.invoke("support.classify", { ticketId: "T-1" }),
    ).resolves.toEqual({ category: "T-1", priority: 3 });
    expect(clientReads).toBe(0);
  });

  it("publishes the same list and describe contracts as the unwrapped map", () => {
    const plain = {
      "support.classify": classifyCapability(),
      "support.route": defineCapability({
        description: "Route a support ticket without optional metadata.",
        input: ticketInput,
        output: ticketOutput,
        access: "authenticated",
        run: async () => ({ category: "route" }),
      }) as AnyCapability,
    };
    const wrapped = applyMiddleware(plain, async ({ next }) => next());
    const plainEngine = engineFor(plain);
    const wrappedEngine = engineFor(wrapped);

    expect(wrappedEngine.list()).toEqual(plainEngine.list());
    for (const capabilityId of Object.keys(plain)) {
      expect(wrappedEngine.describe(capabilityId)).toEqual(
        plainEngine.describe(capabilityId),
      );
    }
    expect(Object.keys(wrapped)).toEqual(Object.keys(plain));
    expect(wrapped["support.route"]).not.toHaveProperty("title");
  });

  it("does not mutate the source map or invoke middleware during construction", () => {
    const original = classifyCapability();
    const source = { "support.classify": original };
    const middleware = vi.fn<CapabilityMiddleware>(async ({ next }) => next());

    const capabilities = applyMiddleware(source, middleware);

    expect(source["support.classify"]).toBe(original);
    expect(capabilities).not.toBe(source);
    expect(middleware).not.toHaveBeenCalled();
  });

  it("reads every capability field exactly once at application time", async () => {
    let reads = 0;
    let current: TicketRun = async () => ({ category: "first" });
    const capability = classifyCapability();
    Object.defineProperty(capability, "run", {
      enumerable: true,
      get() {
        reads += 1;
        return current;
      },
    });
    const capabilities = applyMiddleware(
      { "support.classify": capability },
      async ({ next }) => next(),
    );
    current = async () => ({ category: "second" });

    await expect(
      engineFor(capabilities).invoke("support.classify", { ticketId: "T-1" }),
    ).resolves.toEqual({ category: "first", priority: 3 });
    expect(reads).toBe(1);
  });

  it("returns an unwrapped frozen copy when no middleware is supplied", () => {
    const original = classifyCapability();
    const capabilities = applyMiddleware({ "support.classify": original });

    expect(capabilities["support.classify"]).toBe(original);
    expect(Object.isFrozen(capabilities)).toBe(true);
  });

  it("skips undefined map entries like createEngine does", () => {
    const capabilities = applyMiddleware(
      {
        "support.classify": classifyCapability(),
        "support.missing": undefined as unknown as AnyCapability,
      },
      async ({ next }) => next(),
    );

    expect(Object.keys(capabilities)).toEqual(["support.classify"]);
  });

  it.each([
    ["a null map", null, "A capability map must be an object."],
    ["an array map", [], "A capability map must be an object."],
    ["a proxy map", new Proxy({}, {}), "A capability map must not be a proxy."],
    [
      "a non-object capability",
      { "support.classify": "run" },
      "Capability support.classify must be an object.",
    ],
    [
      "a proxy capability",
      { "support.classify": new Proxy(classifyCapability(), {}) },
      "Capability support.classify must not be a proxy.",
    ],
    [
      "a capability without run",
      {
        "support.classify": classifyCapability(undefined, {
          run: undefined,
        } as unknown as Partial<AnyCapability>),
      },
      "Capability support.classify run must be a function.",
    ],
  ])("rejects %s synchronously", (_case, capabilities, message) => {
    expect(() =>
      applyMiddleware(
        capabilities as unknown as Readonly<Record<string, AnyCapability>>,
        async ({ next }) => next(),
      ),
    ).toThrow(new TypeError(message));
  });

  it("rejects a middleware that is not a function", () => {
    expect(() =>
      applyMiddleware(
        { "support.classify": classifyCapability() },
        async ({ next }) => next(),
        "audit" as unknown as CapabilityMiddleware,
      ),
    ).toThrow(new TypeError("Every capability middleware must be a function."));
  });
});

describe("applyMiddleware with capability composition", () => {
  const sourceName = "@community/support-capabilities";

  it("keeps composition provenance only for a composed map", () => {
    const composed = composeCapabilities({
      local: { "support.classify": classifyCapability() },
    });
    const plain = { "support.classify": classifyCapability() };

    expect(
      isComposedCapabilities(
        applyMiddleware(composed, async ({ next }) => next()),
      ),
    ).toBe(true);
    expect(isComposedCapabilities(applyMiddleware(composed))).toBe(true);
    expect(
      isComposedCapabilities(
        applyMiddleware(plain, async ({ next }) => next()),
      ),
    ).toBe(false);
  });

  it("observes effective IDs when applied to the composed map", async () => {
    const observed: string[] = [];
    const exported = defineExportedCapability({
      source: { name: sourceName, version: "1.0.0" },
      defaultId: "community.classify",
      capability: classifyCapability(),
    });
    const library = defineCapabilityLibrary({
      name: sourceName,
      version: "1.0.0",
      capabilities: { "community.route": classifyCapability() },
    });
    const capabilities = applyMiddleware(
      composeCapabilities({
        local: { "app.health": classifyCapability() },
        imports: [
          importCapability(exported, { as: "support.classify" }),
          importCapabilities(library, {
            remap: { "community.route": "support.route" },
          }),
        ],
      }),
      async ({ capabilityId, next }) => {
        observed.push(capabilityId);
        return next();
      },
    );
    const engine = engineFor(capabilities);

    for (const capabilityId of [
      "app.health",
      "support.classify",
      "support.route",
    ]) {
      await engine.invoke(capabilityId, { ticketId: "T-1" });
    }
    expect(observed).toEqual([
      "app.health",
      "support.classify",
      "support.route",
    ]);
  });

  it("composes wrapped capabilities as local, atomic, and library declarations", async () => {
    const observed: string[] = [];
    const observe: CapabilityMiddleware = async ({ capabilityId, next }) => {
      observed.push(capabilityId);
      return next();
    };
    const exported = defineExportedCapability({
      source: { name: sourceName, version: "1.0.0" },
      defaultId: "community.classify",
      capability: applyMiddleware(
        { "community.classify": classifyCapability() },
        observe,
      )["community.classify"] as AnyCapability,
    });
    const library = defineCapabilityLibrary({
      name: sourceName,
      version: "1.0.0",
      capabilities: applyMiddleware(
        { "community.route": classifyCapability() },
        observe,
      ),
    });
    const capabilities = composeCapabilities({
      local: applyMiddleware({ "app.health": classifyCapability() }, observe),
      imports: [
        importCapability(exported, { as: "support.classify" }),
        importCapabilities(library, {
          remap: { "community.route": "support.route" },
        }),
      ],
    });
    const engine = engineFor(capabilities);

    expect(isComposedCapabilities(capabilities)).toBe(true);
    for (const capabilityId of [
      "app.health",
      "support.classify",
      "support.route",
    ]) {
      await expect(
        engine.invoke(capabilityId, { ticketId: "T-1" }),
      ).resolves.toEqual({ category: "billing:T-1", priority: 3 });
    }
    expect(observed).toEqual([
      "app.health",
      "community.classify",
      "community.route",
    ]);
  });
});
