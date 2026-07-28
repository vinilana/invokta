import {
  type CapabilityDescription,
  type CapabilityMap,
  composeCapabilities,
  createEngine,
  defineCapability,
  defineCapabilityLibrary,
  defineExportedCapability,
  type Engine,
  type EngineEvent,
  type ExecutionSource,
  importCapabilities,
  importCapability,
  type Principal,
} from "@ai-engine/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { type CliIo, runCli } from "../src/index.js";

const trustedPrincipal: Principal = { id: "local:operator" };

const effectiveIds = [
  "operations.ping",
  "operations.classify-ticket",
  "health.check",
  "operations.summarize-report",
  "reports.archive",
] as const;

const remappedDefaultIds = [
  "support.classify-ticket",
  "reports.summarize",
] as const;

const provenanceStrings = [
  "@community/support-capabilities/classify-ticket",
  "@community/health-capabilities",
  "@community/report-capabilities",
  "1.4.0",
  "2.1.0",
] as const;

interface AccessCall {
  readonly capabilityId: string;
  readonly source: ExecutionSource;
  readonly requestId: string;
}

interface HandlerCall {
  readonly declaredAs: string;
  readonly source: ExecutionSource;
  readonly requestId: string;
  readonly reachedThroughInvoke: boolean;
}

interface InvokeCall {
  readonly capabilityId: string;
  readonly source: ExecutionSource | undefined;
  readonly principal: Principal | null;
}

interface CompositionProbe {
  readonly accessCalls: AccessCall[];
  readonly handlerCalls: HandlerCall[];
  readonly invokeCalls: InvokeCall[];
  readonly events: EngineEvent[];
  invokeDepth: number;
}

function createProbe(): CompositionProbe {
  return {
    accessCalls: [],
    handlerCalls: [],
    invokeCalls: [],
    events: [],
    invokeDepth: 0,
  };
}

function recordAccess(probe: CompositionProbe) {
  return (args: {
    readonly principal: Principal | null;
    readonly context: { readonly source: ExecutionSource; requestId: string };
    readonly capabilityId: string;
  }): boolean => {
    probe.accessCalls.push({
      capabilityId: args.capabilityId,
      source: args.context.source,
      requestId: args.context.requestId,
    });
    return args.principal !== null;
  };
}

function recordHandler(
  probe: CompositionProbe,
  declaredAs: string,
  context: { readonly source: ExecutionSource; readonly requestId: string },
): void {
  probe.handlerCalls.push({
    declaredAs,
    source: context.source,
    requestId: context.requestId,
    reachedThroughInvoke: probe.invokeDepth > 0,
  });
}

function createClassifyTicketExport(probe: CompositionProbe) {
  return defineExportedCapability({
    source: {
      name: "@community/support-capabilities/classify-ticket",
      version: "1.4.0",
    },
    defaultId: "support.classify-ticket",
    capability: defineCapability({
      title: "Classify ticket",
      description: "Classifies one imported support ticket.",
      input: z.object({ ticketId: z.string().min(1) }),
      output: z.object({ ticketId: z.string(), category: z.string() }),
      access: recordAccess(probe),
      timeoutMs: 5_000,
      annotations: { readOnly: true, idempotent: true },
      async run({ input, context }) {
        recordHandler(probe, "atomic:support.classify-ticket", context);
        return { ticketId: input.ticketId, category: "billing" };
      },
    }),
  });
}

function createHealthCheckExport(probe: CompositionProbe) {
  return defineExportedCapability({
    source: { name: "@community/health-capabilities" },
    defaultId: "health.check",
    capability: defineCapability({
      description: "Reports imported health status.",
      input: z.object({}),
      output: z.object({ status: z.string() }),
      access: recordAccess(probe),
      async run({ context }) {
        recordHandler(probe, "atomic:health.check", context);
        return { status: "ok" };
      },
    }),
  });
}

function createReportLibrary(probe: CompositionProbe) {
  return defineCapabilityLibrary({
    name: "@community/report-capabilities",
    version: "2.1.0",
    capabilities: {
      "reports.summarize": defineCapability({
        title: "Summarize report",
        description: "Summarizes one imported report.",
        input: z.object({ reportId: z.string().min(1) }),
        output: z.object({ reportId: z.string(), summary: z.string() }),
        access: recordAccess(probe),
        annotations: {
          readOnly: true,
          destructive: false,
          idempotent: true,
          openWorld: false,
        },
        async run({ input, context }) {
          recordHandler(probe, "library:reports.summarize", context);
          return {
            reportId: input.reportId,
            summary: `Summary of ${input.reportId}`,
          };
        },
      }),
      "reports.archive": defineCapability({
        description: "Archives one imported report.",
        input: z.object({ reportId: z.string().min(1) }),
        output: z.object({ archived: z.boolean() }),
        access: recordAccess(probe),
        annotations: { destructive: true },
        async run({ context }) {
          recordHandler(probe, "library:reports.archive", context);
          return { archived: true };
        },
      }),
    },
  });
}

function createLocalPing(probe: CompositionProbe) {
  return defineCapability({
    description: "Answers a local liveness probe.",
    input: z.object({}),
    output: z.object({ pong: z.boolean() }),
    access: recordAccess(probe),
    async run({ context }) {
      recordHandler(probe, "local:operations.ping", context);
      return { pong: true };
    },
  });
}

function createComposedCapabilities(probe: CompositionProbe) {
  return composeCapabilities({
    local: {
      "operations.ping": createLocalPing(probe),
    },
    imports: [
      importCapability(createClassifyTicketExport(probe), {
        as: "operations.classify-ticket",
      }),
      importCapability(createHealthCheckExport(probe)),
      importCapabilities(createReportLibrary(probe), {
        include: ["reports.summarize", "reports.archive"],
        remap: { "reports.summarize": "operations.summarize-report" },
      }),
    ],
  });
}

function createComposedEngine(probe: CompositionProbe) {
  return createEngine({
    name: "operations-engine",
    version: "3.0.0",
    capabilities: createComposedCapabilities(probe),
    onEvent(event) {
      probe.events.push(event);
    },
  });
}

function spyOnInvoke<Capabilities extends CapabilityMap>(
  engine: Engine<Capabilities>,
  probe: CompositionProbe,
): Engine<Capabilities> {
  const invoke: Engine<Capabilities>["invoke"] = async (
    capabilityId,
    input,
    options,
  ) => {
    probe.invokeCalls.push({
      capabilityId,
      source: options?.source,
      principal: options?.principal ?? null,
    });
    probe.invokeDepth += 1;
    try {
      return await engine.invoke(capabilityId, input, options);
    } finally {
      probe.invokeDepth -= 1;
    }
  };
  return {
    name: engine.name,
    version: engine.version,
    list: () => engine.list(),
    describe: (capabilityId) => engine.describe(capabilityId),
    invoke,
  };
}

function createIo() {
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
  };
  return { io, stdout, stderr };
}

function expectNoCompositionLeak(serialized: string): void {
  for (const defaultId of remappedDefaultIds) {
    expect(serialized).not.toContain(defaultId);
  }
  for (const provenance of provenanceStrings) {
    expect(serialized).not.toContain(provenance);
  }
}

describe("CLI adapter over remapped imported capabilities", () => {
  it("lists exactly the effective IDs and no remapped default ID", async () => {
    const probe = createProbe();
    const engine = createComposedEngine(probe);
    const output = createIo();

    const code = await runCli(engine, {
      argv: ["list"],
      principal: trustedPrincipal,
      io: output.io,
    });

    const serialized = output.stdout.join("");
    expect(code).toBe(0);
    expect(
      (JSON.parse(serialized) as ReadonlyArray<{ id: string }>).map(
        ({ id }) => id,
      ),
    ).toEqual([...effectiveIds]);
    expectNoCompositionLeak(serialized);
    expect(output.stderr).toEqual([]);
  });

  it.each([
    {
      effectiveId: "operations.classify-ticket",
      exported: (probe: CompositionProbe) =>
        createClassifyTicketExport(probe).capability,
      preserved: {
        title: "Classify ticket",
        description: "Classifies one imported support ticket.",
        annotations: { readOnly: true, idempotent: true },
        timeoutMs: 5_000,
      },
    },
    {
      effectiveId: "operations.summarize-report",
      exported: (probe: CompositionProbe) =>
        createReportLibrary(probe).capabilities["reports.summarize"],
      preserved: {
        title: "Summarize report",
        description: "Summarizes one imported report.",
        annotations: {
          readOnly: true,
          destructive: false,
          idempotent: true,
          openWorld: false,
        },
      },
    },
  ])(
    "describes $effectiveId with the imported schemas and annotations",
    async ({ effectiveId, exported, preserved }) => {
      const probe = createProbe();
      const engine = createComposedEngine(probe);
      const baseline = createEngine({
        name: "baseline-engine",
        version: "3.0.0",
        capabilities: { [effectiveId]: exported(createProbe()) },
      });
      const output = createIo();

      const code = await runCli(engine, {
        argv: ["describe", effectiveId],
        principal: trustedPrincipal,
        io: output.io,
      });

      const serialized = output.stdout.join("");
      expect(code).toBe(0);
      const described = JSON.parse(serialized) as CapabilityDescription;
      expect(described).toEqual(baseline.describe(effectiveId));
      expect(described).toMatchObject({ id: effectiveId, ...preserved });
      expect(described.inputSchema).toMatchObject({ type: "object" });
      expect(described.outputSchema).toMatchObject({ type: "object" });
      expectNoCompositionLeak(serialized);
    },
  );

  it.each(remappedDefaultIds)(
    "fails describe for the unmounted default ID %s",
    async (defaultId) => {
      const probe = createProbe();
      const engine = createComposedEngine(probe);
      const output = createIo();

      const code = await runCli(engine, {
        argv: ["describe", defaultId],
        principal: trustedPrincipal,
        io: output.io,
      });

      expect(code).toBe(1);
      expect(output.stdout).toEqual([]);
      expect(probe.handlerCalls).toEqual([]);
      expect(JSON.parse(output.stderr.join(""))).toEqual({
        error: {
          code: "CAPABILITY_NOT_FOUND",
          message: "Capability not found.",
          publicDetails: { capabilityId: defaultId },
        },
      });
    },
  );

  it.each([
    {
      effectiveId: "operations.classify-ticket",
      input: '{"ticketId":"T-1"}',
      expected: { ticketId: "T-1", category: "billing" },
      declaredAs: "atomic:support.classify-ticket",
    },
    {
      effectiveId: "health.check",
      input: "{}",
      expected: { status: "ok" },
      declaredAs: "atomic:health.check",
    },
    {
      effectiveId: "operations.summarize-report",
      input: '{"reportId":"R-9"}',
      expected: { reportId: "R-9", summary: "Summary of R-9" },
      declaredAs: "library:reports.summarize",
    },
    {
      effectiveId: "reports.archive",
      input: '{"reportId":"R-9"}',
      expected: { archived: true },
      declaredAs: "library:reports.archive",
    },
  ])(
    "runs the imported handler mounted at $effectiveId",
    async ({ effectiveId, input, expected, declaredAs }) => {
      const probe = createProbe();
      const engine = createComposedEngine(probe);
      const output = createIo();

      const code = await runCli(engine, {
        argv: ["run", effectiveId, "--input", input],
        principal: trustedPrincipal,
        io: output.io,
      });

      expect(code).toBe(0);
      expect(JSON.parse(output.stdout.join(""))).toEqual(expected);
      expect(output.stderr).toEqual([]);
      expect(probe.handlerCalls).toHaveLength(1);
      expect(probe.handlerCalls[0]).toMatchObject({
        declaredAs,
        source: "cli",
      });
      expectNoCompositionLeak(output.stdout.join(""));
    },
  );

  it.each(remappedDefaultIds)(
    "fails run for the unmounted default ID %s",
    async (defaultId) => {
      const probe = createProbe();
      const engine = createComposedEngine(probe);
      const output = createIo();

      const code = await runCli(engine, {
        argv: ["run", defaultId, "--input", '{"ticketId":"T-1"}'],
        principal: trustedPrincipal,
        io: output.io,
      });

      expect(code).toBe(1);
      expect(output.stdout).toEqual([]);
      expect(probe.handlerCalls).toEqual([]);
      expect(JSON.parse(output.stderr.join(""))).toEqual({
        error: {
          code: "CAPABILITY_NOT_FOUND",
          message: "Capability not found.",
          publicDetails: { capabilityId: defaultId },
        },
      });
    },
  );

  it("routes every CLI run through one engine.invoke call with the effective ID", async () => {
    const probe = createProbe();
    const engine = spyOnInvoke(createComposedEngine(probe), probe);
    const runs = [
      { effectiveId: "operations.ping", input: "{}" },
      {
        effectiveId: "operations.classify-ticket",
        input: '{"ticketId":"T-2"}',
      },
      { effectiveId: "health.check", input: "{}" },
      {
        effectiveId: "operations.summarize-report",
        input: '{"reportId":"R-1"}',
      },
      { effectiveId: "reports.archive", input: '{"reportId":"R-1"}' },
    ];

    for (const { effectiveId, input } of runs) {
      const output = createIo();
      const code = await runCli(engine, {
        argv: ["run", effectiveId, "--input", input],
        principal: trustedPrincipal,
        io: output.io,
      });
      expect(code).toBe(0);
    }

    expect(probe.invokeCalls).toEqual([
      {
        capabilityId: "operations.ping",
        source: "cli",
        principal: trustedPrincipal,
      },
      {
        capabilityId: "operations.classify-ticket",
        source: "cli",
        principal: trustedPrincipal,
      },
      {
        capabilityId: "health.check",
        source: "cli",
        principal: trustedPrincipal,
      },
      {
        capabilityId: "operations.summarize-report",
        source: "cli",
        principal: trustedPrincipal,
      },
      {
        capabilityId: "reports.archive",
        source: "cli",
        principal: trustedPrincipal,
      },
    ]);
    expect(probe.handlerCalls).toHaveLength(runs.length);
    expect(probe.handlerCalls.every((call) => call.reachedThroughInvoke)).toBe(
      true,
    );
    expect(probe.handlerCalls.map((call) => call.source)).toEqual(
      runs.map(() => "cli"),
    );
    expect(probe.handlerCalls.map((call) => call.declaredAs)).toEqual([
      "local:operations.ping",
      "atomic:support.classify-ticket",
      "atomic:health.check",
      "library:reports.summarize",
      "library:reports.archive",
    ]);
    expect(probe.handlerCalls.map((call) => call.requestId)).toEqual(
      probe.events
        .filter((event) => event.type === "invocation.started")
        .map((event) => event.requestId),
    );
  });

  it("gives access rules and engine events the effective ID", async () => {
    const probe = createProbe();
    const engine = spyOnInvoke(createComposedEngine(probe), probe);

    for (const { effectiveId, input } of [
      {
        effectiveId: "operations.classify-ticket",
        input: '{"ticketId":"T-3"}',
      },
      {
        effectiveId: "operations.summarize-report",
        input: '{"reportId":"R-2"}',
      },
      { effectiveId: "health.check", input: "{}" },
      { effectiveId: "reports.archive", input: '{"reportId":"R-2"}' },
    ]) {
      const output = createIo();
      expect(
        await runCli(engine, {
          argv: ["run", effectiveId, "--input", input],
          principal: trustedPrincipal,
          io: output.io,
        }),
      ).toBe(0);
    }

    const invokedEffectiveIds = [
      "operations.classify-ticket",
      "operations.summarize-report",
      "health.check",
      "reports.archive",
    ];
    expect(probe.accessCalls.map((call) => call.capabilityId)).toEqual(
      invokedEffectiveIds,
    );
    expect(probe.accessCalls.map((call) => call.source)).toEqual(
      invokedEffectiveIds.map(() => "cli"),
    );
    expect(
      probe.events
        .filter((event) => event.type === "invocation.started")
        .map((event) => event.capabilityId),
    ).toEqual(invokedEffectiveIds);
    expect(
      probe.events
        .filter((event) => event.type === "invocation.completed")
        .map((event) => event.capabilityId),
    ).toEqual(invokedEffectiveIds);
    expect(
      probe.events.some((event) => event.type === "invocation.failed"),
    ).toBe(false);
    expectNoCompositionLeak(JSON.stringify(probe.events));
    expectNoCompositionLeak(JSON.stringify(probe.accessCalls));
  });
});
