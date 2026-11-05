import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  CapabilityError,
  type CapabilityErrorMap,
  createEngine,
  defineCapability,
  EngineError,
  type EngineErrorCode,
  type EngineEvent,
  type EngineSchema,
} from "../src/index.js";

const input = z.object({ slotId: z.string().min(1) });
const output = z.object({ confirmed: z.boolean() });

const errors = {
  SLOT_CONFLICT: {
    description: "The requested slot is no longer available.",
    details: z.object({
      slotId: z.string(),
      alternatives: z.array(z.string()).max(3),
    }),
  },
  CALENDAR_UNAVAILABLE: {
    description: "The calendar provider is temporarily unavailable.",
    retryable: true,
  },
} satisfies CapabilityErrorMap;

function scheduleEngine(
  run: (args: {
    input: { slotId: string };
    signal: AbortSignal;
  }) => Promise<{ confirmed: boolean }>,
  options: {
    readonly errors?: CapabilityErrorMap | undefined;
    readonly timeoutMs?: number;
    readonly events?: EngineEvent[];
  } = {},
) {
  return createEngine({
    name: "appointments-engine",
    version: "0.1.0",
    capabilities: {
      "appointments.schedule": defineCapability({
        description: "Schedule an appointment in a free slot.",
        input,
        output,
        access: "public",
        ...("errors" in options
          ? options.errors === undefined
            ? {}
            : { errors: options.errors }
          : { errors }),
        ...(options.timeoutMs === undefined
          ? {}
          : { timeoutMs: options.timeoutMs }),
        run: ({ input: value, context }) =>
          run({ input: value, signal: context.signal }),
      }),
    },
    ...(options.events === undefined
      ? {}
      : {
          onEvent(event: EngineEvent) {
            options.events?.push(event);
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

function objectSchema(
  validate: EngineSchema["~standard"]["validate"],
  jsonSchema: Record<string, unknown> = { type: "object" },
): EngineSchema {
  return {
    "~standard": {
      version: 1,
      vendor: "domain-error-test",
      validate,
      jsonSchema: {
        input: () => jsonSchema,
        output: () => jsonSchema,
      },
    },
  };
}

describe("declared domain errors", () => {
  it("publishes a declared domain error with validated details", async () => {
    const events: EngineEvent[] = [];
    const providerFailure = new Error("private calendar response");
    const raised = new CapabilityError<typeof errors>("SLOT_CONFLICT", {
      details: { slotId: "S-1", alternatives: ["S-2"] },
      cause: providerFailure,
    });
    const engine = scheduleEngine(
      async () => {
        throw raised;
      },
      { events },
    );

    const error = await expectEngineError(
      engine.invoke("appointments.schedule", { slotId: "S-1" }),
      "DOMAIN_ERROR",
    );

    expect(error.message).toBe("The requested slot is no longer available.");
    expect(error.publicDetails).toEqual({
      code: "SLOT_CONFLICT",
      retryable: false,
      details: { slotId: "S-1", alternatives: ["S-2"] },
    });
    expect(Object.isFrozen(error.publicDetails)).toBe(true);
    expect(error.cause).toBe(raised);
    expect(raised.cause).toBe(providerFailure);
    expect(JSON.stringify(error.publicDetails)).not.toContain("private");
    expect(events.at(-1)).toEqual({
      type: "invocation.failed",
      requestId: events[0]?.requestId,
      capabilityId: "appointments.schedule",
      durationMs: expect.any(Number),
      code: "DOMAIN_ERROR",
      domainCode: "SLOT_CONFLICT",
    });
  });

  it("publishes a retryable domain error without details", async () => {
    const engine = scheduleEngine(async () => {
      throw new CapabilityError<typeof errors>("CALENDAR_UNAVAILABLE");
    });

    const error = await expectEngineError(
      engine.invoke("appointments.schedule", { slotId: "S-1" }),
      "DOMAIN_ERROR",
    );

    expect(error.message).toBe(
      "The calendar provider is temporarily unavailable.",
    );
    expect(error.publicDetails).toEqual({
      code: "CALENDAR_UNAVAILABLE",
      retryable: true,
    });
  });

  it("publishes the transformed and snapshotted details value", async () => {
    const callerOwned = { slotId: " S-1 " };
    const engine = scheduleEngine(
      async () => {
        throw new CapabilityError("TRIMMED", { details: callerOwned });
      },
      {
        errors: {
          TRIMMED: {
            description: "A slot conflict with normalized details.",
            details: z.object({
              slotId: z
                .string()
                .transform((value) => value.trim())
                .pipe(z.string()),
            }),
          },
        },
      },
    );

    const error = await expectEngineError(
      engine.invoke("appointments.schedule", { slotId: "S-1" }),
      "DOMAIN_ERROR",
    );
    callerOwned.slotId = "mutated";

    expect(error.publicDetails).toEqual({
      code: "TRIMMED",
      retryable: false,
      details: { slotId: "S-1" },
    });
    expect(
      Object.isFrozen((error.publicDetails as { details: object }).details),
    ).toBe(true);
  });

  it.each([
    [
      "an undeclared code",
      () => new CapabilityError("UNDECLARED_OUTCOME"),
      errors,
    ],
    [
      "invalid declared details",
      () =>
        new CapabilityError("SLOT_CONFLICT", {
          details: { slotId: 42, secret: "private-detail" },
        }),
      errors,
    ],
    [
      "missing declared details",
      () => new CapabilityError("SLOT_CONFLICT"),
      errors,
    ],
    [
      "details for a declaration without a details schema",
      () =>
        new CapabilityError("CALENDAR_UNAVAILABLE", {
          details: { secret: "private-detail" },
        }),
      errors,
    ],
    [
      "a capability that declares no domain errors",
      () => new CapabilityError("SLOT_CONFLICT"),
      undefined,
    ],
  ] as const)(
    "fails closed with EXECUTION_FAILED for %s",
    async (_case, createError, declaredErrors) => {
      const events: EngineEvent[] = [];
      const raised = createError();
      const engine = scheduleEngine(
        async () => {
          throw raised;
        },
        { errors: declaredErrors, events },
      );

      const error = await expectEngineError(
        engine.invoke("appointments.schedule", { slotId: "S-1" }),
        "EXECUTION_FAILED",
      );

      expect(error.message).toBe("Capability execution failed.");
      expect(error.publicDetails).toBeUndefined();
      expect(error.cause).toBe(raised);
      expect(events.at(-1)).toEqual({
        type: "invocation.failed",
        requestId: events[0]?.requestId,
        capabilityId: "appointments.schedule",
        durationMs: expect.any(Number),
        code: "EXECUTION_FAILED",
      });
    },
  );

  it("fails closed when declared details transform outside an object", async () => {
    const engine = scheduleEngine(
      async () => {
        throw new CapabilityError("SCALAR", { details: { value: "x" } });
      },
      {
        errors: {
          SCALAR: {
            description: "Details that transform to a scalar.",
            details: objectSchema(() => ({ value: "scalar" })),
          },
        },
      },
    );

    await expectEngineError(
      engine.invoke("appointments.schedule", { slotId: "S-1" }),
      "EXECUTION_FAILED",
    );
  });

  it("fails closed when a details validator throws", async () => {
    const validatorFailure = new Error("private validator failure");
    const raised = new CapabilityError("BROKEN", { details: {} });
    const engine = scheduleEngine(
      async () => {
        throw raised;
      },
      {
        errors: {
          BROKEN: {
            description: "A domain error with a failing validator.",
            details: objectSchema(() => {
              throw validatorFailure;
            }),
          },
        },
      },
    );

    const error = await expectEngineError(
      engine.invoke("appointments.schedule", { slotId: "S-1" }),
      "EXECUTION_FAILED",
    );
    expect(error.cause).toBe(raised);
  });

  it.each([
    [
      "a structural look-alike",
      () => ({
        name: "CapabilityError",
        code: "CALENDAR_UNAVAILABLE",
        message: "forged",
      }),
    ],
    [
      "an object with the CapabilityError prototype",
      () =>
        Object.assign(Object.create(CapabilityError.prototype) as object, {
          code: "CALENDAR_UNAVAILABLE",
        }),
    ],
    [
      "a forged DOMAIN_ERROR EngineError",
      () =>
        new EngineError({
          code: "DOMAIN_ERROR" as EngineErrorCode,
          message: "Forged domain outcome.",
          publicDetails: {
            code: "CALENDAR_UNAVAILABLE",
            retryable: true,
            details: { secret: "private-detail" },
          },
        }),
    ],
  ])("rejects %s as EXECUTION_FAILED", async (_case, createError) => {
    const forged = createError();
    const engine = scheduleEngine(async () => {
      throw forged;
    });

    const error = await expectEngineError(
      engine.invoke("appointments.schedule", { slotId: "S-1" }),
      "EXECUTION_FAILED",
    );

    expect(error.message).toBe("Capability execution failed.");
    expect(error.publicDetails).toBeUndefined();
    expect(error.cause).toBe(forged);
  });

  it("contains a proxy-wrapped CapabilityError without invoking its traps", async () => {
    const trap = vi.fn(() => {
      throw new Error("private proxy trap");
    });
    const hostile = new Proxy(
      new CapabilityError<typeof errors>("CALENDAR_UNAVAILABLE"),
      { get: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap },
    );
    const engine = scheduleEngine(async () => {
      throw hostile;
    });

    const error = await expectEngineError(
      engine.invoke("appointments.schedule", { slotId: "S-1" }),
      "EXECUTION_FAILED",
    );

    expect(Object.is(error.cause, hostile)).toBe(true);
    expect(trap).not.toHaveBeenCalled();
  });

  it("uses the constructor-time code and details after property mutation", async () => {
    const raised = new CapabilityError<typeof errors>("CALENDAR_UNAVAILABLE");
    const getter = vi.fn(() => "SLOT_CONFLICT");
    Object.defineProperty(raised, "code", { configurable: true, get: getter });
    Object.defineProperty(raised, "details", {
      configurable: true,
      value: { secret: "private-detail" },
    });
    const engine = scheduleEngine(async () => {
      throw raised;
    });

    const error = await expectEngineError(
      engine.invoke("appointments.schedule", { slotId: "S-1" }),
      "DOMAIN_ERROR",
    );

    expect(error.publicDetails).toEqual({
      code: "CALENDAR_UNAVAILABLE",
      retryable: true,
    });
    expect(getter).not.toHaveBeenCalled();
  });

  it("does not forward a domain error issued by another invocation", async () => {
    const inner = scheduleEngine(async () => {
      throw new CapabilityError<typeof errors>("CALENDAR_UNAVAILABLE");
    });
    const outer = scheduleEngine(
      async ({ input: value }) =>
        inner.invoke("appointments.schedule", { slotId: value.slotId }),
      { errors: {} },
    );

    const error = await expectEngineError(
      outer.invoke("appointments.schedule", { slotId: "S-1" }),
      "EXECUTION_FAILED",
    );

    expect((error.cause as EngineError).code).toBe("DOMAIN_ERROR");
  });

  it("does not publish a domain error raised by the access rule", async () => {
    const run = vi.fn(async () => ({ confirmed: true }));
    const engine = createEngine({
      name: "access-domain-error-engine",
      version: "0.1.0",
      capabilities: {
        guarded: defineCapability({
          description: "Raise a declared domain error during authorization.",
          input,
          output,
          errors,
          access: () => {
            throw new CapabilityError<typeof errors>("CALENDAR_UNAVAILABLE");
          },
          run,
        }),
      },
    });

    await expectEngineError(
      engine.invoke("guarded", { slotId: "S-1" }),
      "EXECUTION_FAILED",
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("reports cancellation when the handler raises a domain error after abort", async () => {
    const controller = new AbortController();
    const engine = scheduleEngine(async () => {
      controller.abort(new Error("Caller disconnected."));
      throw new CapabilityError<typeof errors>("CALENDAR_UNAVAILABLE");
    });

    await expectEngineError(
      engine.invoke(
        "appointments.schedule",
        { slotId: "S-1" },
        { signal: controller.signal },
      ),
      "CANCELLED",
    );
  });

  it("applies the capability timeout to asynchronous details validation", async () => {
    let resolveValidation: (() => void) | undefined;
    const engine = scheduleEngine(
      async () => {
        throw new CapabilityError("SLOW", { details: {} });
      },
      {
        timeoutMs: 20,
        errors: {
          SLOW: {
            description: "A domain error with slow validation.",
            details: objectSchema(
              () =>
                new Promise((resolve) => {
                  resolveValidation = () => resolve({ value: {} });
                }),
            ),
          },
        },
      },
    );

    const error = await expectEngineError(
      engine.invoke("appointments.schedule", { slotId: "S-1" }),
      "CANCELLED",
    );
    resolveValidation?.();
    expect(error.message).toBe("Capability invocation was cancelled.");
  });
});

describe("domain error contracts", () => {
  it("describes declared domain errors with their details JSON Schema", () => {
    const engine = scheduleEngine(async () => ({ confirmed: true }));

    const description = engine.describe("appointments.schedule");

    expect(description.errors).toEqual([
      {
        code: "SLOT_CONFLICT",
        description: "The requested slot is no longer available.",
        retryable: false,
        detailsSchema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            slotId: { type: "string" },
            alternatives: {
              type: "array",
              items: { type: "string" },
              maxItems: 3,
            },
          },
          required: ["slotId", "alternatives"],
          additionalProperties: false,
        },
      },
      {
        code: "CALENDAR_UNAVAILABLE",
        description: "The calendar provider is temporarily unavailable.",
        retryable: true,
      },
    ]);
    expect(Object.isFrozen(description.errors)).toBe(true);
    expect(Object.isFrozen(description.errors?.[0]?.detailsSchema)).toBe(true);
    expect(engine.list()[0]).not.toHaveProperty("errors");
  });

  it("omits errors from a description when none are declared", () => {
    const withoutErrors = scheduleEngine(async () => ({ confirmed: true }), {
      errors: undefined,
    });
    const withEmptyErrors = scheduleEngine(async () => ({ confirmed: true }), {
      errors: {},
    });

    expect(withoutErrors.describe("appointments.schedule")).not.toHaveProperty(
      "errors",
    );
    expect(
      withEmptyErrors.describe("appointments.schedule"),
    ).not.toHaveProperty("errors");
  });

  it("snapshots domain error declarations when the engine is created", async () => {
    const declarations = {
      CALENDAR_UNAVAILABLE: {
        description: "The calendar provider is temporarily unavailable.",
        retryable: true,
      },
    } as Record<string, { description: string; retryable?: boolean }>;
    const engine = scheduleEngine(
      async () => {
        throw new CapabilityError("CALENDAR_UNAVAILABLE");
      },
      { errors: declarations },
    );
    const declaration = declarations.CALENDAR_UNAVAILABLE as {
      description: string;
      retryable?: boolean;
    };
    declaration.description = "mutated";
    declaration.retryable = false;
    declarations.ADDED_LATER = { description: "Added after construction." };

    const error = await expectEngineError(
      engine.invoke("appointments.schedule", { slotId: "S-1" }),
      "DOMAIN_ERROR",
    );

    expect(error.message).toBe(
      "The calendar provider is temporarily unavailable.",
    );
    expect(error.publicDetails).toEqual({
      code: "CALENDAR_UNAVAILABLE",
      retryable: true,
    });
    expect(
      engine.describe("appointments.schedule").errors?.map(({ code }) => code),
    ).toEqual(["CALENDAR_UNAVAILABLE"]);
  });

  it.each([
    ["a lowercase code", { slot_conflict: { description: "x" } }],
    ["a leading digit", { "1_CONFLICT": { description: "x" } }],
    ["a trailing underscore", { CONFLICT_: { description: "x" } }],
    ["a doubled underscore", { SLOT__CONFLICT: { description: "x" } }],
    ["an empty code", { "": { description: "x" } }],
    [
      "a code longer than 64 characters",
      { [`A${"B".repeat(64)}`]: { description: "x" } },
    ],
  ])("rejects %s at engine construction", (_case, declaredErrors) => {
    expect(() =>
      scheduleEngine(async () => ({ confirmed: true }), {
        errors: declaredErrors as CapabilityErrorMap,
      }),
    ).toThrow(
      new TypeError(
        "Capability appointments.schedule declares an invalid domain error code.",
      ),
    );
  });

  it("accepts a 64-character domain error code", () => {
    const code = `A${"B".repeat(63)}`;
    const engine = scheduleEngine(async () => ({ confirmed: true }), {
      errors: { [code]: { description: "The longest accepted code." } },
    });

    expect(engine.describe("appointments.schedule").errors?.[0]?.code).toBe(
      code,
    );
  });

  it.each([
    "CAPABILITY_NOT_FOUND",
    "INPUT_INVALID",
    "UNAUTHENTICATED",
    "FORBIDDEN",
    "OUTPUT_INVALID",
    "CANCELLED",
    "EXECUTION_FAILED",
    "DOMAIN_ERROR",
  ])("rejects the framework code %s as a domain error code", (code) => {
    expect(() =>
      scheduleEngine(async () => ({ confirmed: true }), {
        errors: { [code]: { description: "Shadow a framework code." } },
      }),
    ).toThrow(
      new TypeError(
        `Capability appointments.schedule domain error ${code} reuses a framework error code.`,
      ),
    );
  });

  it("bounds the number of declared domain errors", () => {
    const declaredErrors = (count: number) =>
      Object.fromEntries(
        Array.from({ length: count }, (_value, index) => [
          `ERROR_${index}`,
          { description: `Domain error ${index}.` },
        ]),
      );

    expect(() =>
      scheduleEngine(async () => ({ confirmed: true }), {
        errors: declaredErrors(64),
      }),
    ).not.toThrow();
    expect(() =>
      scheduleEngine(async () => ({ confirmed: true }), {
        errors: declaredErrors(65),
      }),
    ).toThrow(
      new TypeError(
        "Capability appointments.schedule declares more than 64 domain errors.",
      ),
    );
  });

  it.each([
    ["a missing description", {}],
    ["an empty description", { description: "" }],
    ["a non-string description", { description: 42 }],
    [
      "a description longer than 1024 characters",
      { description: "x".repeat(1025) },
    ],
    ["a non-boolean retryable flag", { description: "x", retryable: "yes" }],
    ["an unknown declaration field", { description: "x", retriable: true }],
    ["a non-object details schema", { description: "x", details: "object" }],
  ])("rejects %s at engine construction", (_case, declaration) => {
    expect(() =>
      scheduleEngine(async () => ({ confirmed: true }), {
        errors: { BROKEN: declaration } as unknown as CapabilityErrorMap,
      }),
    ).toThrow(
      new TypeError(
        "Capability appointments.schedule domain error BROKEN has an invalid declaration.",
      ),
    );
  });

  it("accepts a 1024-character description", () => {
    const description = "x".repeat(1024);
    const engine = scheduleEngine(async () => ({ confirmed: true }), {
      errors: { LONG: { description } },
    });

    expect(engine.describe("appointments.schedule").errors?.[0]).toEqual({
      code: "LONG",
      description,
      retryable: false,
    });
  });

  it.each([
    ["an array", []],
    ["a string", "SLOT_CONFLICT"],
    ["null", null],
    ["a custom prototype", Object.create({ inherited: true }) as object],
    ["a proxy", new Proxy({}, {})],
  ])("rejects %s as the errors field", (_case, declaredErrors) => {
    expect(() =>
      scheduleEngine(async () => ({ confirmed: true }), {
        errors: declaredErrors as unknown as CapabilityErrorMap,
      }),
    ).toThrow(
      new TypeError(
        "Capability appointments.schedule errors must be a record of domain error declarations.",
      ),
    );
  });

  it("rejects accessor-backed declarations without invoking them", () => {
    const getter = vi.fn(() => ({ description: "x" }));
    const descriptionGetter = vi.fn(() => "x");
    const accessorEntry = Object.defineProperty({}, "SLOT_CONFLICT", {
      enumerable: true,
      get: getter,
    });
    const accessorField = {
      SLOT_CONFLICT: Object.defineProperty({}, "description", {
        enumerable: true,
        get: descriptionGetter,
      }),
    };

    expect(() =>
      scheduleEngine(async () => ({ confirmed: true }), {
        errors: accessorEntry as CapabilityErrorMap,
      }),
    ).toThrow(
      new TypeError(
        "Capability appointments.schedule domain error SLOT_CONFLICT has an invalid declaration.",
      ),
    );
    expect(() =>
      scheduleEngine(async () => ({ confirmed: true }), {
        errors: accessorField as unknown as CapabilityErrorMap,
      }),
    ).toThrow(
      new TypeError(
        "Capability appointments.schedule domain error SLOT_CONFLICT has an invalid declaration.",
      ),
    );
    expect(getter).not.toHaveBeenCalled();
    expect(descriptionGetter).not.toHaveBeenCalled();
  });

  it("rejects a details schema without an object root", () => {
    expect(() =>
      scheduleEngine(async () => ({ confirmed: true }), {
        errors: {
          SCALAR: { description: "x", details: z.string() },
        },
      }),
    ).toThrow(
      new TypeError(
        "Capability appointments.schedule domain error SCALAR details schema must have an object root.",
      ),
    );
  });

  it("rejects a details schema that cannot produce a JSON Schema", () => {
    const withoutConverter = {
      "~standard": {
        version: 1,
        vendor: "domain-error-test",
        validate: () => ({ value: {} }),
      },
    } as unknown as EngineSchema;

    expect(() =>
      scheduleEngine(async () => ({ confirmed: true }), {
        errors: { BROKEN: { description: "x", details: withoutConverter } },
      }),
    ).toThrow(
      new TypeError(
        "Capability appointments.schedule domain error BROKEN could not produce its details JSON Schema.",
      ),
    );
  });
});

describe("CapabilityError", () => {
  it("keeps its constructor arguments as inspectable error metadata", () => {
    const cause = new Error("private cause");
    const raised = new CapabilityError<typeof errors>("SLOT_CONFLICT", {
      details: { slotId: "S-1", alternatives: [] },
      cause,
    });

    expect(raised).toBeInstanceOf(Error);
    expect(raised.name).toBe("CapabilityError");
    expect(raised.message).toBe("A capability raised a domain error.");
    expect(raised.code).toBe("SLOT_CONFLICT");
    expect(raised.details).toEqual({ slotId: "S-1", alternatives: [] });
    expect(raised.cause).toBe(cause);
    expect(new CapabilityError("PLAIN").cause).toBeUndefined();
    expect(new CapabilityError("PLAIN").details).toBeUndefined();
  });
});
