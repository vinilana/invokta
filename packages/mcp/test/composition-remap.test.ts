import {
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
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createMcpServer } from "../src/protocol-server.js";

const trustedPrincipal: Principal = {
  id: "local:mcp-host",
  attributes: { team: "operations" },
};

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
    readonly context: {
      readonly source: ExecutionSource;
      readonly requestId: string;
    };
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

function createComposedEngine(probe: CompositionProbe) {
  return createEngine({
    name: "operations-engine",
    version: "3.0.0",
    capabilities: composeCapabilities({
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
    }),
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

const openClients: Client[] = [];

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close()));
});

async function connect(engine: Parameters<typeof createMcpServer>[0]) {
  const server = createMcpServer(engine, {
    principal: trustedPrincipal,
    source: "mcp-stdio",
  });
  const client = new Client(
    { name: "mcp-composition-test", version: "0.0.0-test" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  openClients.push(client);
  return { client, server };
}

function expectNoCompositionLeak(serialized: string): void {
  for (const defaultId of remappedDefaultIds) {
    expect(serialized).not.toContain(defaultId);
  }
  for (const provenance of provenanceStrings) {
    expect(serialized).not.toContain(provenance);
  }
}

describe("MCP adapter over remapped imported capabilities", () => {
  it("advertises exactly the effective IDs as tool names", async () => {
    const probe = createProbe();
    const { client } = await connect(createComposedEngine(probe));

    const listed = await client.listTools();

    expect(listed.tools.map((tool) => tool.name)).toEqual([...effectiveIds]);
    expectNoCompositionLeak(JSON.stringify(listed.tools));
  });

  it.each([
    {
      effectiveId: "operations.classify-ticket",
      capability: (probe: CompositionProbe) =>
        createClassifyTicketExport(probe).capability,
      title: "Classify ticket",
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputProperty: "ticketId",
      outputProperty: "category",
    },
    {
      effectiveId: "operations.summarize-report",
      capability: (probe: CompositionProbe) =>
        createReportLibrary(probe).capabilities["reports.summarize"],
      title: "Summarize report",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputProperty: "reportId",
      outputProperty: "summary",
    },
    {
      effectiveId: "health.check",
      capability: (probe: CompositionProbe) =>
        createHealthCheckExport(probe).capability,
      title: undefined,
      annotations: undefined,
      inputProperty: undefined,
      outputProperty: "status",
    },
    {
      effectiveId: "reports.archive",
      capability: (probe: CompositionProbe) =>
        createReportLibrary(probe).capabilities["reports.archive"],
      title: undefined,
      annotations: { destructiveHint: true },
      inputProperty: "reportId",
      outputProperty: "archived",
    },
  ])(
    "advertises the imported schemas and annotations for $effectiveId",
    async ({
      effectiveId,
      capability,
      title,
      annotations,
      inputProperty,
      outputProperty,
    }) => {
      const probe = createProbe();
      const { client } = await connect(createComposedEngine(probe));
      const baseline = createEngine({
        name: "baseline-engine",
        version: "3.0.0",
        capabilities: { [effectiveId]: capability(createProbe()) },
      });
      const expected = baseline.describe(effectiveId);

      const listed = await client.listTools();
      const tool = listed.tools.find(({ name }) => name === effectiveId);

      expect(tool).toEqual({
        name: effectiveId,
        description: expected.description,
        inputSchema: expected.inputSchema,
        outputSchema: expected.outputSchema,
        ...(title === undefined ? {} : { title }),
        ...(annotations === undefined ? {} : { annotations }),
      });
      if (inputProperty !== undefined) {
        expect(tool?.inputSchema.properties).toHaveProperty(inputProperty);
      }
      expect(
        (tool?.outputSchema as { readonly properties?: unknown } | undefined)
          ?.properties,
      ).toHaveProperty(outputProperty);
      expectNoCompositionLeak(JSON.stringify(tool));
    },
  );

  it.each([
    {
      effectiveId: "operations.classify-ticket",
      arguments: { ticketId: "T-1" },
      structuredContent: { ticketId: "T-1", category: "billing" },
    },
    {
      effectiveId: "health.check",
      arguments: {},
      structuredContent: { status: "ok" },
    },
    {
      effectiveId: "operations.summarize-report",
      arguments: { reportId: "R-9" },
      structuredContent: { reportId: "R-9", summary: "Summary of R-9" },
    },
    {
      effectiveId: "reports.archive",
      arguments: { reportId: "R-9" },
      structuredContent: { archived: true },
    },
  ])(
    "calls the imported capability mounted at $effectiveId",
    async ({ effectiveId, arguments: toolArguments, structuredContent }) => {
      const probe = createProbe();
      const { client } = await connect(createComposedEngine(probe));

      const result = await client.callTool({
        name: effectiveId,
        arguments: toolArguments,
      });

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual(structuredContent);
      expect(
        JSON.parse(
          (result.content as ReadonlyArray<{ readonly text: string }>)[0]
            ?.text ?? "null",
        ),
      ).toEqual(structuredContent);
      expect(probe.handlerCalls).toHaveLength(1);
      expectNoCompositionLeak(JSON.stringify(result));
    },
  );

  it.each(remappedDefaultIds)(
    "rejects the unmounted default ID %s like any unknown tool",
    async (defaultId) => {
      const probe = createProbe();
      const engine = spyOnInvoke(createComposedEngine(probe), probe);
      const { client } = await connect(engine);

      const captureFailure = async (name: string): Promise<unknown> =>
        client.callTool({ name, arguments: { ticketId: "T-1" } }).then(
          () => undefined,
          (error: unknown) => error,
        );
      const unmountedFailure = await captureFailure(defaultId);
      const unknownFailure = await captureFailure("operations.never-declared");

      expect(unmountedFailure).toMatchObject({ code: ErrorCode.InvalidParams });
      expect(unknownFailure).toMatchObject({ code: ErrorCode.InvalidParams });
      expect((unmountedFailure as { readonly code: number }).code).toBe(
        (unknownFailure as { readonly code: number }).code,
      );
      expect((unmountedFailure as Error).message).toContain(
        `Tool ${defaultId} not found`,
      );
      expect((unknownFailure as Error).message).toContain(
        "Tool operations.never-declared not found",
      );
      expect(probe.invokeCalls).toEqual([]);
      expect(probe.handlerCalls).toEqual([]);
      expect(probe.events).toEqual([]);
    },
  );

  it("routes every tools/call through one engine.invoke call with the effective ID", async () => {
    const probe = createProbe();
    const engine = spyOnInvoke(createComposedEngine(probe), probe);
    const { client } = await connect(engine);
    const calls = [
      { name: "operations.ping", arguments: {} },
      { name: "operations.classify-ticket", arguments: { ticketId: "T-2" } },
      { name: "health.check", arguments: {} },
      { name: "operations.summarize-report", arguments: { reportId: "R-1" } },
      { name: "reports.archive", arguments: { reportId: "R-1" } },
    ];

    for (const call of calls) {
      const result = await client.callTool(call);
      expect(result.isError).toBeUndefined();
    }

    expect(probe.invokeCalls).toEqual([
      {
        capabilityId: "operations.ping",
        source: "mcp-stdio",
        principal: trustedPrincipal,
      },
      {
        capabilityId: "operations.classify-ticket",
        source: "mcp-stdio",
        principal: trustedPrincipal,
      },
      {
        capabilityId: "health.check",
        source: "mcp-stdio",
        principal: trustedPrincipal,
      },
      {
        capabilityId: "operations.summarize-report",
        source: "mcp-stdio",
        principal: trustedPrincipal,
      },
      {
        capabilityId: "reports.archive",
        source: "mcp-stdio",
        principal: trustedPrincipal,
      },
    ]);
    expect(probe.handlerCalls).toHaveLength(calls.length);
    expect(probe.handlerCalls.every((call) => call.reachedThroughInvoke)).toBe(
      true,
    );
    expect(probe.handlerCalls.map((call) => call.source)).toEqual(
      calls.map(() => "mcp-stdio"),
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
    const { client } = await connect(engine);
    const invokedEffectiveIds = [
      "operations.classify-ticket",
      "operations.summarize-report",
      "health.check",
      "reports.archive",
    ];

    await client.callTool({
      name: "operations.classify-ticket",
      arguments: { ticketId: "T-3" },
    });
    await client.callTool({
      name: "operations.summarize-report",
      arguments: { reportId: "R-2" },
    });
    await client.callTool({ name: "health.check", arguments: {} });
    await client.callTool({
      name: "reports.archive",
      arguments: { reportId: "R-2" },
    });

    expect(probe.accessCalls.map((call) => call.capabilityId)).toEqual(
      invokedEffectiveIds,
    );
    expect(probe.accessCalls.map((call) => call.source)).toEqual(
      invokedEffectiveIds.map(() => "mcp-stdio"),
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
