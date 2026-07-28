import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  type AccessRule,
  type AnyCapability,
  type AnyCapabilityImport,
  CapabilityCompositionError,
  type CapabilityDescription,
  type CapabilitySummary,
  composeCapabilities,
  createEngine,
  defineCapability,
  defineCapabilityLibrary,
  defineExportedCapability,
  EngineError,
  type EngineErrorCode,
  type EngineEvent,
  type ExecutionContext,
  type InvokeOptions,
  importCapabilities,
  importCapability,
  type Principal,
} from "../src/index.js";

const ticketInput = z.object({ ticketId: z.string().min(1) });
const ticketOutput = z.object({ category: z.string() });

type TicketValue = z.infer<typeof ticketInput>;
type TicketRun = (args: {
  readonly input: TicketValue;
  readonly context: ExecutionContext;
}) => Promise<{ category: string }>;

/**
 * The default ID and the effective ID share no substring, so an assertion that
 * the default ID never leaks cannot pass by accident.
 */
const defaultId = "community.default-capability";
const effectiveId = "operations.effective-capability";
const sourceName = "@community/support-capabilities";
const sourceVersion = "1.4.0";

/**
 * Local and imported engines are driven through one helper so the battery can
 * compare observed results instead of hand-written expectations per engine.
 */
interface ContractEngine {
  invoke(
    capabilityId: string,
    input: unknown,
    options?: InvokeOptions,
  ): Promise<unknown>;
  list(): ReadonlyArray<CapabilitySummary>;
  describe(capabilityId: string): CapabilityDescription;
}

interface Counters {
  access: number;
  run: number;
}

function createCounters(): Counters {
  return { access: 0, run: 0 };
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

function expectSyncEngineError(
  read: () => unknown,
  code: EngineErrorCode,
): EngineError {
  try {
    read();
  } catch (error) {
    expect(error).toBeInstanceOf(EngineError);
    expect((error as EngineError).code).toBe(code);
    return error as EngineError;
  }
  throw new Error(`Expected EngineError with code ${code}.`);
}

function captureCompositionError(
  build: () => unknown,
): CapabilityCompositionError {
  try {
    build();
  } catch (error) {
    expect(error).toBeInstanceOf(CapabilityCompositionError);
    return error as CapabilityCompositionError;
  }
  throw new Error("Expected composition to throw CapabilityCompositionError.");
}

function classifyCapability(counters: Counters): AnyCapability {
  return defineCapability({
    title: "Classify ticket",
    description: "Classify a support ticket.",
    input: ticketInput,
    output: ticketOutput,
    access: "public",
    async run({ input }) {
      counters.run += 1;
      return { category: `billing:${input.ticketId}` };
    },
  }) as AnyCapability;
}

function exportedCapability(capability: AnyCapability) {
  return defineExportedCapability({
    source: { name: sourceName, version: sourceVersion },
    defaultId,
    capability,
  });
}

function capabilityLibrary(capability: AnyCapability) {
  return defineCapabilityLibrary({
    name: sourceName,
    version: sourceVersion,
    capabilities: { [defaultId]: capability },
  });
}

function recordEvents(events: EngineEvent[]): (event: EngineEvent) => void {
  return (event) => {
    events.push(event);
  };
}

function registerLocal(
  capability: AnyCapability,
  events: EngineEvent[],
): ContractEngine {
  return createEngine({
    name: "local-engine",
    version: "1.0.0",
    capabilities: { [effectiveId]: capability },
    onEvent: recordEvents(events),
  });
}

function registerAtomicImport(
  capability: AnyCapability,
  events: EngineEvent[],
): ContractEngine {
  return createEngine({
    name: "atomic-import-engine",
    version: "1.0.0",
    capabilities: composeCapabilities({
      imports: [
        importCapability(exportedCapability(capability), { as: effectiveId }),
      ],
    }),
    onEvent: recordEvents(events),
  });
}

function registerLibraryImport(
  capability: AnyCapability,
  events: EngineEvent[],
): ContractEngine {
  return createEngine({
    name: "library-import-engine",
    version: "1.0.0",
    capabilities: composeCapabilities({
      imports: [
        importCapabilities(capabilityLibrary(capability), {
          remap: { [defaultId]: effectiveId },
        }),
      ],
    }),
    onEvent: recordEvents(events),
  });
}

type RegisterEngine = (
  capability: AnyCapability,
  events: EngineEvent[],
) => ContractEngine;

const registrations: ReadonlyArray<readonly [string, RegisterEngine]> = [
  ["local", registerLocal],
  ["atomic import", registerAtomicImport],
  ["library import", registerLibraryImport],
];

const remappedRegistrations: ReadonlyArray<readonly [string, RegisterEngine]> =
  [
    ["an atomic import with as", registerAtomicImport],
    ["a library import with remap", registerLibraryImport],
  ];

describe("library factories reused by independent engines", () => {
  interface TicketClassifier {
    classify(ticketId: string): Promise<string>;
  }
  interface TicketPermissions {
    can(principalId: string, ticketId: string): boolean;
  }
  interface SupportDependencies {
    readonly classifier: TicketClassifier;
    readonly permissions: TicketPermissions;
  }

  function createSupportLibrary(dependencies: SupportDependencies) {
    return defineCapabilityLibrary({
      name: sourceName,
      version: sourceVersion,
      capabilities: {
        "support.classify-ticket": defineCapability({
          title: "Classify ticket",
          description: "Classify a support ticket.",
          input: ticketInput,
          output: ticketOutput,
          access: ({ principal, input }) =>
            principal !== null &&
            dependencies.permissions.can(principal.id, input.ticketId),
          async run({ input }) {
            return {
              category: await dependencies.classifier.classify(input.ticketId),
            };
          },
        }),
      },
    });
  }

  function createTenant(tenant: string, allowedPrincipalId: string) {
    const classified: string[] = [];
    const authorized: string[] = [];
    const dependencies: SupportDependencies = {
      classifier: {
        async classify(ticketId) {
          classified.push(ticketId);
          return `${tenant}:${ticketId}`;
        },
      },
      permissions: {
        can(principalId, ticketId) {
          authorized.push(`${principalId}/${ticketId}`);
          return principalId === allowedPrincipalId;
        },
      },
    };
    return { classified, authorized, dependencies };
  }

  it("gives two engines different behavior from one factory without shared state", async () => {
    const billing = createTenant("billing", "user:billing");
    const technical = createTenant("technical", "user:technical");
    const billingLibrary = createSupportLibrary(billing.dependencies);
    const technicalLibrary = createSupportLibrary(technical.dependencies);
    const billingEngine = createEngine({
      name: "billing-engine",
      version: "1.0.0",
      capabilities: composeCapabilities({
        imports: [importCapabilities(billingLibrary)],
      }),
    });
    const technicalEngine = createEngine({
      name: "technical-engine",
      version: "1.0.0",
      capabilities: composeCapabilities({
        imports: [
          importCapabilities(technicalLibrary, {
            remap: { "support.classify-ticket": "operations.classify-ticket" },
          }),
        ],
      }),
    });

    expect(billingLibrary).not.toBe(technicalLibrary);
    expect(billingEngine.list().map((summary) => summary.id)).toEqual([
      "support.classify-ticket",
    ]);
    expect(technicalEngine.list().map((summary) => summary.id)).toEqual([
      "operations.classify-ticket",
    ]);

    await expect(
      billingEngine.invoke(
        "support.classify-ticket",
        { ticketId: "T-1" },
        { principal: { id: "user:billing" } },
      ),
    ).resolves.toEqual({ category: "billing:T-1" });
    await expect(
      technicalEngine.invoke(
        "operations.classify-ticket",
        { ticketId: "T-1" },
        { principal: { id: "user:technical" } },
      ),
    ).resolves.toEqual({ category: "technical:T-1" });

    await expectEngineError(
      billingEngine.invoke(
        "support.classify-ticket",
        { ticketId: "T-2" },
        { principal: { id: "user:technical" } },
      ),
      "FORBIDDEN",
    );
    await expectEngineError(
      technicalEngine.invoke(
        "operations.classify-ticket",
        { ticketId: "T-3" },
        { principal: { id: "user:billing" } },
      ),
      "FORBIDDEN",
    );

    expect(billing.classified).toEqual(["T-1"]);
    expect(technical.classified).toEqual(["T-1"]);
    expect(billing.authorized).toEqual([
      "user:billing/T-1",
      "user:technical/T-2",
    ]);
    expect(technical.authorized).toEqual([
      "user:technical/T-1",
      "user:billing/T-3",
    ]);

    await expectEngineError(
      (billingEngine as ContractEngine).invoke("operations.classify-ticket", {
        ticketId: "T-4",
      }),
      "CAPABILITY_NOT_FOUND",
    );
    await expectEngineError(
      (technicalEngine as ContractEngine).invoke("support.classify-ticket", {
        ticketId: "T-4",
      }),
      "CAPABILITY_NOT_FOUND",
    );
  });
});

describe("default effective IDs", () => {
  const defaultIdRegistrations: ReadonlyArray<
    readonly [string, (capability: AnyCapability) => ContractEngine]
  > = [
    [
      "an atomic import without as",
      (capability) =>
        createEngine({
          name: "atomic-default-engine",
          version: "1.0.0",
          capabilities: composeCapabilities({
            imports: [importCapability(exportedCapability(capability))],
          }),
        }),
    ],
    [
      "a library import without remap",
      (capability) =>
        createEngine({
          name: "library-default-engine",
          version: "1.0.0",
          capabilities: composeCapabilities({
            imports: [importCapabilities(capabilityLibrary(capability))],
          }),
        }),
    ],
  ];

  it.each(defaultIdRegistrations)(
    "registers the default ID for %s",
    async (_label, register) => {
      const counters = createCounters();
      const engine = register(classifyCapability(counters));

      expect(engine.list()).toEqual([
        {
          id: defaultId,
          title: "Classify ticket",
          description: "Classify a support ticket.",
        },
      ]);
      expect(engine.describe(defaultId)).toMatchObject({
        id: defaultId,
        title: "Classify ticket",
        description: "Classify a support ticket.",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
      });
      await expect(
        engine.invoke(defaultId, { ticketId: "T-1" }),
      ).resolves.toEqual({ category: "billing:T-1" });
      expect(counters.run).toBe(1);
    },
  );
});

describe("remapped effective IDs", () => {
  it.each(remappedRegistrations)(
    "registers only the effective ID for %s",
    async (_label, register) => {
      const counters = createCounters();
      const engine = register(classifyCapability(counters), []);

      expect(engine.list().map((summary) => summary.id)).toEqual([effectiveId]);
      expect(engine.describe(effectiveId).id).toBe(effectiveId);
      await expect(
        engine.invoke(effectiveId, { ticketId: "T-1" }),
      ).resolves.toEqual({ category: "billing:T-1" });

      const invokeError = await expectEngineError(
        engine.invoke(defaultId, { ticketId: "T-1" }),
        "CAPABILITY_NOT_FOUND",
      );
      const describeError = expectSyncEngineError(
        () => engine.describe(defaultId),
        "CAPABILITY_NOT_FOUND",
      );

      expect(invokeError.publicDetails).toEqual({ capabilityId: defaultId });
      expect(describeError.publicDetails).toEqual({ capabilityId: defaultId });
      expect(counters.run).toBe(1);
    },
  );
});

describe("effective IDs in access rules and events", () => {
  interface AccessArguments {
    readonly principal: Principal | null;
    readonly input: unknown;
    readonly context: ExecutionContext;
    readonly capabilityId: string;
  }

  function observedCapability(observed: AccessArguments[]): AnyCapability {
    return defineCapability({
      description: "Report the identity the engine used.",
      input: ticketInput,
      output: ticketOutput,
      access: (args) => {
        observed.push(args);
        return true;
      },
      async run({ input }) {
        return { category: `billing:${input.ticketId}` };
      },
    }) as AnyCapability;
  }

  it.each(remappedRegistrations)(
    "delivers the effective ID to the access rule and every event of %s",
    async (_label, register) => {
      const observed: AccessArguments[] = [];
      const events: EngineEvent[] = [];
      const engine = register(observedCapability(observed), events);

      await expect(
        engine.invoke(
          effectiveId,
          { ticketId: "T-1" },
          { requestId: "request-1", principal: { id: "user:1" } },
        ),
      ).resolves.toEqual({ category: "billing:T-1" });

      const accessArguments = observed[0];

      expect(observed).toHaveLength(1);
      expect(accessArguments?.capabilityId).toBe(effectiveId);
      expect(Object.keys(accessArguments ?? {})).toEqual([
        "principal",
        "input",
        "context",
        "capabilityId",
      ]);
      expect(Object.keys(accessArguments?.context ?? {})).toEqual([
        "requestId",
        "source",
        "principal",
        "signal",
        "logger",
      ]);
      expect(
        JSON.stringify({
          capabilityId: accessArguments?.capabilityId,
          input: accessArguments?.input,
          principal: accessArguments?.principal,
          requestId: accessArguments?.context.requestId,
          source: accessArguments?.context.source,
          contextPrincipal: accessArguments?.context.principal,
        }),
      ).not.toContain(defaultId);
      expect(events).toEqual([
        {
          type: "invocation.started",
          requestId: "request-1",
          capabilityId: effectiveId,
          source: "direct",
          principalId: "user:1",
          startedAt: expect.any(String),
        },
        {
          type: "invocation.completed",
          requestId: "request-1",
          capabilityId: effectiveId,
          durationMs: expect.any(Number),
        },
      ]);
      expect(JSON.stringify(events)).not.toContain(defaultId);
    },
  );

  it.each(remappedRegistrations)(
    "reports the effective ID on a failed invocation of %s",
    async (_label, register) => {
      const events: EngineEvent[] = [];
      const engine = register(
        defineCapability({
          description: "Fail with the effective identity.",
          input: ticketInput,
          output: ticketOutput,
          access: "public",
          async run() {
            throw new Error("private handler failure");
          },
        }) as AnyCapability,
        events,
      );

      await expectEngineError(
        engine.invoke(effectiveId, { ticketId: "T-1" }, { requestId: "req-2" }),
        "EXECUTION_FAILED",
      );

      expect(events).toEqual([
        {
          type: "invocation.started",
          requestId: "req-2",
          capabilityId: effectiveId,
          source: "direct",
          startedAt: expect.any(String),
        },
        {
          type: "invocation.failed",
          requestId: "req-2",
          capabilityId: effectiveId,
          durationMs: expect.any(Number),
          code: "EXECUTION_FAILED",
        },
      ]);
      expect(JSON.stringify(events)).not.toContain(defaultId);
    },
  );
});

type Outcome =
  | { readonly status: "fulfilled"; readonly value: unknown }
  | {
      readonly status: "rejected";
      readonly code: EngineErrorCode;
      readonly message: string;
      readonly publicDetails: unknown;
    };

interface Observation {
  readonly outcome: Outcome;
  readonly calls: { readonly access: number; readonly run: number };
  readonly summaries: ReadonlyArray<CapabilitySummary>;
  readonly description: CapabilityDescription;
  readonly events: ReadonlyArray<Readonly<Record<string, unknown>>>;
}

interface ParityScenario {
  readonly capability: AnyCapability;
  invoke(engine: ContractEngine): Promise<unknown>;
}

interface ParityCase {
  readonly name: string;
  readonly create: (counters: Counters) => ParityScenario;
  readonly status: Outcome["status"];
  readonly code?: EngineErrorCode;
  readonly calls: { readonly access: number; readonly run: number };
}

async function settle(promise: Promise<unknown>): Promise<Outcome> {
  try {
    return { status: "fulfilled", value: await promise };
  } catch (error) {
    expect(error).toBeInstanceOf(EngineError);
    const engineError = error as EngineError;
    return {
      status: "rejected",
      code: engineError.code,
      message: engineError.message,
      publicDetails: engineError.publicDetails,
    };
  }
}

/**
 * Timing fields cannot match across engines, so they are compared by type while
 * every identifying field is compared by value.
 */
function normalizeEvent(event: EngineEvent): Readonly<Record<string, unknown>> {
  const normalized: Record<string, unknown> = { ...event };
  if ("durationMs" in normalized) {
    normalized.durationMs = typeof normalized.durationMs;
  }
  if ("startedAt" in normalized) {
    normalized.startedAt = typeof normalized.startedAt;
  }
  return normalized;
}

function parityCapability(overrides: {
  readonly access?: AccessRule<TicketValue>;
  readonly timeoutMs?: number;
  readonly run: TicketRun;
}): AnyCapability {
  return defineCapability({
    title: "Classify ticket",
    description: "Classify a support ticket.",
    input: ticketInput,
    output: ticketOutput,
    access: overrides.access ?? "public",
    annotations: {
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: false,
    },
    ...(overrides.timeoutMs === undefined
      ? {}
      : { timeoutMs: overrides.timeoutMs }),
    run: overrides.run,
  }) as AnyCapability;
}

function countingRun(
  counters: Counters,
  run: (input: TicketValue) => Promise<{ category: string }>,
): TicketRun {
  return async ({ input }) => {
    counters.run += 1;
    return run(input);
  };
}

function countingAccess(
  counters: Counters,
  decide: () => boolean,
): AccessRule<TicketValue> {
  return () => {
    counters.access += 1;
    return decide();
  };
}

function invokeWith(input: unknown, options?: InvokeOptions) {
  return (engine: ContractEngine): Promise<unknown> =>
    engine.invoke(effectiveId, input, {
      requestId: "parity-request",
      ...(options ?? {}),
    });
}

const parityCases: ReadonlyArray<ParityCase> = [
  {
    name: "returns the validated output",
    create: (counters) => ({
      capability: parityCapability({
        run: countingRun(counters, async (input) => ({
          category: `billing:${input.ticketId}`,
        })),
      }),
      invoke: invokeWith({ ticketId: "T-1" }),
    }),
    status: "fulfilled",
    calls: { access: 0, run: 1 },
  },
  {
    name: "rejects invalid input before the handler",
    create: (counters) => ({
      capability: parityCapability({
        run: countingRun(counters, async () => ({ category: "billing" })),
      }),
      invoke: invokeWith({ ticketId: "" }),
    }),
    status: "rejected",
    code: "INPUT_INVALID",
    calls: { access: 0, run: 0 },
  },
  {
    name: "rejects invalid output after the handler",
    create: (counters) => ({
      capability: parityCapability({
        run: countingRun(
          counters,
          async () => ({ category: 42 }) as unknown as { category: string },
        ),
      }),
      invoke: invokeWith({ ticketId: "T-1" }),
    }),
    status: "rejected",
    code: "OUTPUT_INVALID",
    calls: { access: 0, run: 1 },
  },
  {
    name: "requires a principal for authenticated access",
    create: (counters) => ({
      capability: parityCapability({
        access: "authenticated",
        run: countingRun(counters, async () => ({ category: "billing" })),
      }),
      invoke: invokeWith({ ticketId: "T-1" }),
    }),
    status: "rejected",
    code: "UNAUTHENTICATED",
    calls: { access: 0, run: 0 },
  },
  {
    name: "forbids a denied access decision",
    create: (counters) => ({
      capability: parityCapability({
        access: countingAccess(counters, () => false),
        run: countingRun(counters, async () => ({ category: "billing" })),
      }),
      invoke: invokeWith({ ticketId: "T-1" }, { principal: { id: "user:1" } }),
    }),
    status: "rejected",
    code: "FORBIDDEN",
    calls: { access: 1, run: 0 },
  },
  {
    name: "normalizes an unknown handler failure",
    create: (counters) => ({
      capability: parityCapability({
        access: countingAccess(counters, () => true),
        run: countingRun(counters, async () => {
          throw new Error("private handler failure");
        }),
      }),
      invoke: invokeWith({ ticketId: "T-1" }, { principal: { id: "user:1" } }),
    }),
    status: "rejected",
    code: "EXECUTION_FAILED",
    calls: { access: 1, run: 1 },
  },
  {
    name: "cancels on a caller signal",
    create: (counters) => {
      let started = Promise.withResolvers<void>();
      return {
        capability: parityCapability({
          run: countingRun(counters, async () => {
            started.resolve();
            await new Promise<void>(() => undefined);
            return { category: "unreachable" };
          }),
        }),
        async invoke(engine) {
          started = Promise.withResolvers<void>();
          const controller = new AbortController();
          const invocation = invokeWith(
            { ticketId: "T-1" },
            { signal: controller.signal },
          )(engine);
          await started.promise;
          controller.abort();
          return invocation;
        },
      };
    },
    status: "rejected",
    code: "CANCELLED",
    calls: { access: 0, run: 1 },
  },
  {
    name: "cancels when the capability timeout expires",
    create: (counters) => ({
      capability: parityCapability({
        timeoutMs: 10,
        run: countingRun(counters, async () => {
          await new Promise<void>(() => undefined);
          return { category: "unreachable" };
        }),
      }),
      invoke: invokeWith({ ticketId: "T-1" }),
    }),
    status: "rejected",
    code: "CANCELLED",
    calls: { access: 0, run: 1 },
  },
];

describe("imported capabilities behave exactly like local ones", () => {
  it.each(parityCases.map((testCase) => [testCase.name, testCase] as const))(
    "%s identically for a local, atomic, and library registration",
    async (_label, testCase) => {
      const counters = createCounters();
      const scenario = testCase.create(counters);
      const observations: Observation[] = [];

      for (const [, register] of registrations) {
        const events: EngineEvent[] = [];
        const engine = register(scenario.capability, events);
        const before = { access: counters.access, run: counters.run };
        const outcome = await settle(scenario.invoke(engine));
        observations.push({
          outcome,
          calls: {
            access: counters.access - before.access,
            run: counters.run - before.run,
          },
          summaries: engine.list(),
          description: engine.describe(effectiveId),
          events: events.map(normalizeEvent),
        });
      }

      const [local, atomic, library] = observations;

      expect(observations).toHaveLength(registrations.length);
      expect(local?.outcome.status).toBe(testCase.status);
      if (testCase.code !== undefined) {
        expect(local?.outcome).toMatchObject({ code: testCase.code });
      }
      expect(local?.calls).toEqual(testCase.calls);
      expect(local?.description.id).toBe(effectiveId);
      expect(atomic).toEqual(local);
      expect(library).toEqual(local);
    },
  );

  it("preserves title, description, annotations, timeoutMs, and schemas", async () => {
    const counters = createCounters();
    const capability = parityCapability({
      timeoutMs: 250,
      access: countingAccess(counters, () => true),
      run: countingRun(counters, async (input) => ({
        category: `billing:${input.ticketId}`,
      })),
    });
    const descriptions: CapabilityDescription[] = [];
    const summaries: ReadonlyArray<CapabilitySummary>[] = [];

    for (const [, register] of registrations) {
      const engine = register(capability, []);
      descriptions.push(engine.describe(effectiveId));
      summaries.push(engine.list());
      await expect(
        engine.invoke(effectiveId, { ticketId: "T-1" }),
      ).resolves.toEqual({ category: "billing:T-1" });
    }

    const [localDescription, atomicDescription, libraryDescription] =
      descriptions;
    const [localSummaries, atomicSummaries, librarySummaries] = summaries;

    expect(localDescription).toMatchObject({
      id: effectiveId,
      title: "Classify ticket",
      description: "Classify a support ticket.",
      timeoutMs: 250,
      annotations: {
        readOnly: true,
        destructive: false,
        idempotent: true,
        openWorld: false,
      },
      inputSchema: {
        type: "object",
        properties: { ticketId: { type: "string", minLength: 1 } },
        required: ["ticketId"],
      },
      outputSchema: {
        type: "object",
        properties: { category: { type: "string" } },
        required: ["category"],
      },
    });
    expect(localSummaries).toEqual([
      {
        id: effectiveId,
        title: "Classify ticket",
        description: "Classify a support ticket.",
        annotations: {
          readOnly: true,
          destructive: false,
          idempotent: true,
          openWorld: false,
        },
      },
    ]);
    expect(atomicDescription).toEqual(localDescription);
    expect(libraryDescription).toEqual(localDescription);
    expect(atomicSummaries).toEqual(localSummaries);
    expect(librarySummaries).toEqual(localSummaries);
    expect(counters).toEqual({ access: 3, run: 3 });
  });
});

describe("generated compositions at engine scale", () => {
  const generatedCount = 5_000;

  function generatedId(prefix: string, index: number): string {
    return `${prefix}.capability-${String(index).padStart(4, "0")}`;
  }

  it("mounts 10,000 generated declarations without executing access or run", async () => {
    const counters = createCounters();
    const capability = parityCapability({
      access: countingAccess(counters, () => true),
      run: countingRun(counters, async (input) => ({
        category: `billing:${input.ticketId}`,
      })),
    });
    const local: Record<string, AnyCapability> = {};
    const imports: AnyCapabilityImport[] = [];
    for (let index = 0; index < generatedCount; index += 1) {
      local[generatedId("local", index)] = capability;
      imports.push(
        importCapability(
          defineExportedCapability({
            source: { name: sourceName, version: sourceVersion },
            defaultId: generatedId("community", index),
            capability,
          }),
          { as: generatedId("imported", index) },
        ),
      );
    }

    const composed = composeCapabilities({ local, imports });

    expect(Object.keys(composed)).toHaveLength(generatedCount * 2);
    expect(counters).toEqual({ access: 0, run: 0 });

    const engine: ContractEngine = createEngine({
      name: "generated-engine",
      version: "1.0.0",
      capabilities: composed,
    });

    expect(engine.list()).toHaveLength(generatedCount * 2);
    expect(counters).toEqual({ access: 0, run: 0 });
    expect(engine.describe(generatedId("imported", 4_999)).id).toBe(
      generatedId("imported", 4_999),
    );
    expectSyncEngineError(
      () => engine.describe(generatedId("community", 4_999)),
      "CAPABILITY_NOT_FOUND",
    );
    await expectEngineError(
      engine.invoke(generatedId("community", 0), { ticketId: "T-1" }),
      "CAPABILITY_NOT_FOUND",
    );
    expect(counters).toEqual({ access: 0, run: 0 });

    await expect(
      engine.invoke(generatedId("imported", 0), { ticketId: "T-1" }),
    ).resolves.toEqual({ category: "billing:T-1" });
    expect(counters).toEqual({ access: 1, run: 1 });
  });

  it("reports every collision of 10,000 generated declarations before an engine exists", () => {
    const counters = createCounters();
    const capability = parityCapability({
      access: countingAccess(counters, () => true),
      run: countingRun(counters, async () => ({ category: "billing" })),
    });
    const local: Record<string, AnyCapability> = {};
    const imports: AnyCapabilityImport[] = [];
    for (let index = 0; index < generatedCount; index += 1) {
      local[generatedId("generated", index)] = capability;
      imports.push(
        importCapability(
          defineExportedCapability({
            source: { name: sourceName, version: sourceVersion },
            defaultId: generatedId("community", index),
            capability,
          }),
          { as: generatedId("generated", index) },
        ),
      );
    }
    let engineCreated = false;

    const error = captureCompositionError(() => {
      const composed = composeCapabilities({ local, imports });
      engineCreated = true;
      return createEngine({
        name: "colliding-generated-engine",
        version: "1.0.0",
        capabilities: composed,
      });
    });
    const collisions = error.issues.filter(
      (issue) => issue.code === "CAPABILITY_ID_COLLISION",
    );

    expect(engineCreated).toBe(false);
    expect(error.issues).toHaveLength(generatedCount);
    expect(collisions).toHaveLength(generatedCount);
    expect(collisions[0]).toEqual({
      code: "CAPABILITY_ID_COLLISION",
      effectiveId: generatedId("generated", 0),
      declarations: [
        { kind: "local", localId: generatedId("generated", 0) },
        {
          kind: "atomic",
          sourceName,
          sourceVersion,
          defaultId: generatedId("community", 0),
        },
      ],
    });
    expect(collisions.at(-1)).toMatchObject({
      effectiveId: generatedId("generated", generatedCount - 1),
    });
    expect(counters).toEqual({ access: 0, run: 0 });
  });
});
