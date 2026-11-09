import {
  type CapabilityAnnotations,
  type CapabilityDeprecation,
  type CapabilityMap,
  type Engine,
  EngineError,
  type EngineErrorCode,
  type EngineJsonSchema,
  type ExecutionSource,
  type Principal,
} from "@invokta/core";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

import { createProgressForwarder, readProgressToken } from "./progress.js";
import { ProtocolVersionServer } from "./protocol-version.js";
import {
  createMcpToolCatalogReport,
  createMcpToolResult,
  type McpToolCallResult,
  type McpToolCatalogReport,
  type McpToolContentPlan,
  planMcpToolContent,
} from "./tool-content.js";
import { toMcpToolName } from "./tool-name.js";

/**
 * Decides whether one capability is listed for, and callable by, the
 * authenticated principal. It is synchronous and reads only its arguments; a
 * hidden capability answers exactly like a nonexistent tool. Visibility never
 * grants access: the capability's access rule still runs on every call.
 */
export type McpCapabilityVisibility = (args: {
  readonly principal: Principal | null;
  readonly capabilityId: string;
}) => boolean;

/** Validates an optional visibility option before an adapter serves. */
export function snapshotVisibility(
  value: unknown,
): McpCapabilityVisibility | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "function") {
    throw new TypeError("visibility must be a function.");
  }
  return value as McpCapabilityVisibility;
}

/**
 * Binds a visibility option to one request's principal. The predicate sees a
 * deep-frozen copy, so it cannot change the identity that reaches `invoke`,
 * and anything but a returned `true`, including a throw, hides the tool.
 */
export function bindVisibility(
  visibility: McpCapabilityVisibility | undefined,
  principal: Principal | null,
): ((capabilityId: string) => boolean) | undefined {
  if (visibility === undefined) return undefined;
  const frozen =
    principal === null ? null : deepFreeze(structuredClone(principal));
  return (capabilityId) => {
    try {
      return visibility({ principal: frozen, capabilityId }) === true;
    } catch {
      return false;
    }
  };
}

/** Spreads a bound visibility into server options only when configured. */
export function optionalVisible(
  visible: ((capabilityId: string) => boolean) | undefined,
): { readonly visible?: (capabilityId: string) => boolean } {
  return visible === undefined ? {} : { visible };
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

interface McpServerOptions {
  readonly principal: Principal | null;
  readonly source: Extract<ExecutionSource, "mcp-stdio" | "mcp-http">;
  /** Bound visibility of the request's principal; every tool when absent. */
  readonly visible?: (capabilityId: string) => boolean;
  readonly requestSignal?: AbortSignal;
  /**
   * Reports whether the response channel can take another progress
   * notification now. While it returns `false`, at most one report is held.
   */
  readonly canSendProgress?: () => boolean;
}

interface McpObjectSchema extends Readonly<Record<string, unknown>> {
  readonly type: "object";
}

const ENGINE_ERROR_CODES = new Set<EngineErrorCode>([
  "CAPABILITY_NOT_FOUND",
  "INPUT_INVALID",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "OUTPUT_INVALID",
  "CANCELLED",
  "EXECUTION_FAILED",
  "DOMAIN_ERROR",
]);

const EXECUTION_FAILED_TEXT = JSON.stringify({
  code: "EXECUTION_FAILED",
  message: "Capability execution failed.",
});

function asObjectSchema(schema: EngineJsonSchema): McpObjectSchema {
  return schema as McpObjectSchema;
}

function mapAnnotations(annotations: CapabilityAnnotations | undefined):
  | {
      readonly readOnlyHint?: boolean;
      readonly destructiveHint?: boolean;
      readonly idempotentHint?: boolean;
      readonly openWorldHint?: boolean;
    }
  | undefined {
  if (annotations === undefined) return undefined;
  return {
    ...(annotations.readOnly === undefined
      ? {}
      : { readOnlyHint: annotations.readOnly }),
    ...(annotations.destructive === undefined
      ? {}
      : { destructiveHint: annotations.destructive }),
    ...(annotations.idempotent === undefined
      ? {}
      : { idempotentHint: annotations.idempotent }),
    ...(annotations.openWorld === undefined
      ? {}
      : { openWorldHint: annotations.openWorld }),
  };
}

/** Reverse-DNS `_meta` key carrying a capability's deprecation notice. */
const DEPRECATED_META_KEY = "dev.invokta/deprecated";

/**
 * Leads the tool description with the notice so every MCP client, including
 * one that ignores `_meta`, shows the deprecation to the model and the user.
 */
function describeTool(
  description: string,
  deprecated: CapabilityDeprecation | undefined,
): string {
  if (deprecated === undefined) return description;
  const since =
    deprecated.since === undefined ? "" : ` since ${deprecated.since}`;
  const replacement =
    deprecated.replacement === undefined
      ? ""
      : `\nReplacement: ${deprecated.replacement}`;
  return `Deprecated${since}: ${deprecated.reason}${replacement}\n\n${description}`;
}

function serializeEngineError(error: unknown): string {
  try {
    if (!(error instanceof EngineError)) return EXECUTION_FAILED_TEXT;

    const code: unknown = error.code;
    const message: unknown = error.message;
    const publicDetails: unknown = error.publicDetails;
    if (
      typeof code !== "string" ||
      !ENGINE_ERROR_CODES.has(code as EngineErrorCode) ||
      typeof message !== "string"
    ) {
      return EXECUTION_FAILED_TEXT;
    }

    return JSON.stringify({
      code,
      message,
      ...(publicDetails === undefined ? {} : { publicDetails }),
    });
  } catch {
    return EXECUTION_FAILED_TEXT;
  }
}

function errorResult(error: unknown) {
  return {
    isError: true as const,
    content: [
      {
        type: "text" as const,
        text: serializeEngineError(error),
      },
    ],
  };
}

interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: McpObjectSchema;
  readonly outputSchema: McpObjectSchema;
  readonly title?: string;
  readonly annotations?: ReturnType<typeof mapAnnotations>;
  readonly _meta?: Readonly<Record<string, CapabilityDeprecation>>;
}

export interface McpToolCatalog<Capabilities extends CapabilityMap> {
  readonly tools: ReadonlyArray<McpToolDefinition>;
  capabilityIdForToolName(
    toolName: string,
  ): Extract<keyof Capabilities, string> | undefined;
  toolResult(
    capabilityId: string,
    output: Readonly<Record<string, unknown>>,
    protocolVersion: string,
  ): McpToolCallResult;
}

export class McpToolNameCollisionError extends TypeError {
  readonly code = "MCP_TOOL_NAME_COLLISION" as const;
  readonly capabilityIds: readonly [string, string];

  constructor(
    capabilityIds: readonly [string, string],
    readonly toolName: string,
  ) {
    super(
      `Capabilities ${JSON.stringify(capabilityIds[0])} and ${JSON.stringify(capabilityIds[1])} resolve to duplicate MCP tool name ${JSON.stringify(toolName)}.`,
    );
    this.name = "McpToolNameCollisionError";
    this.capabilityIds = Object.freeze([...capabilityIds]) as readonly [
      string,
      string,
    ];
  }
}

export function createMcpToolCatalog<Capabilities extends CapabilityMap>(
  engine: Engine<Capabilities>,
): McpToolCatalog<Capabilities> {
  type CapabilityId = Extract<keyof Capabilities, string>;
  const capabilityIdByToolName = new Map<string, CapabilityId>();
  const contentPlanByCapabilityId = new Map<string, McpToolContentPlan>();
  const tools = engine.list().map((summary) => {
    const capabilityId = summary.id as CapabilityId;
    const toolName = toMcpToolName(capabilityId);
    const existingCapabilityId = capabilityIdByToolName.get(toolName);
    if (existingCapabilityId !== undefined) {
      const firstCapabilityId =
        existingCapabilityId < capabilityId
          ? existingCapabilityId
          : capabilityId;
      const secondCapabilityId =
        existingCapabilityId < capabilityId
          ? capabilityId
          : existingCapabilityId;
      throw new McpToolNameCollisionError(
        [firstCapabilityId, secondCapabilityId],
        toolName,
      );
    }
    capabilityIdByToolName.set(toolName, capabilityId);

    const description = engine.describe(capabilityId);
    contentPlanByCapabilityId.set(
      capabilityId,
      planMcpToolContent(description.outputSchema),
    );
    const annotations = mapAnnotations(description.annotations);
    return Object.freeze({
      name: toolName,
      description: describeTool(
        description.description,
        description.deprecated,
      ),
      inputSchema: asObjectSchema(description.inputSchema),
      outputSchema: asObjectSchema(description.outputSchema),
      ...(description.title === undefined ? {} : { title: description.title }),
      ...(annotations === undefined ? {} : { annotations }),
      ...(description.deprecated === undefined
        ? {}
        : { _meta: { [DEPRECATED_META_KEY]: description.deprecated } }),
    });
  });
  const frozenTools = Object.freeze(tools);

  return Object.freeze({
    tools: frozenTools,
    capabilityIdForToolName: (toolName: string) =>
      capabilityIdByToolName.get(toolName),
    toolResult: (
      capabilityId: string,
      output: Readonly<Record<string, unknown>>,
      protocolVersion: string,
    ) =>
      createMcpToolResult(
        contentPlanByCapabilityId.get(capabilityId) ?? [],
        output,
        protocolVersion,
      ),
  });
}

/**
 * Validates the exact MCP tool catalog without starting an adapter and reports
 * annotated output properties that will not produce content blocks.
 */
export function validateMcpToolCatalog<Capabilities extends CapabilityMap>(
  engine: Engine<Capabilities>,
): McpToolCatalogReport {
  const catalog = createMcpToolCatalog(engine);
  return createMcpToolCatalogReport(
    catalog.tools.map((tool) => ({
      capabilityId: catalog.capabilityIdForToolName(tool.name) as string,
      toolName: tool.name,
      outputSchema: tool.outputSchema,
    })),
  );
}

export function createMcpServer<Capabilities extends CapabilityMap>(
  engine: Engine<Capabilities>,
  options: McpServerOptions,
  catalog: McpToolCatalog<Capabilities> = createMcpToolCatalog(engine),
): Server {
  const server = new ProtocolVersionServer(
    { name: engine.name, version: engine.version },
    { capabilities: { tools: {} } },
  );

  const visible = options.visible;
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools:
      visible === undefined
        ? Array.from(catalog.tools)
        : catalog.tools.filter((tool) =>
            visible(catalog.capabilityIdForToolName(tool.name) as string),
          ),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const capabilityId = catalog.capabilityIdForToolName(request.params.name);
    // A hidden tool is indistinguishable from a nonexistent one.
    if (
      capabilityId === undefined ||
      (visible !== undefined && !visible(capabilityId))
    ) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Tool ${request.params.name} not found`,
      );
    }
    const progressToken = readProgressToken(request.params);
    const progress =
      progressToken === undefined
        ? undefined
        : createProgressForwarder(
            progressToken,
            (params) =>
              extra.sendNotification({
                method: "notifications/progress",
                params,
              }),
            options.canSendProgress,
          );
    try {
      const result = await engine.invoke(
        capabilityId,
        (request.params.arguments ?? {}) as never,
        {
          source: options.source,
          principal: options.principal,
          signal:
            options.requestSignal === undefined
              ? extra.signal
              : AbortSignal.any([extra.signal, options.requestSignal]),
          ...(progress === undefined ? {} : { onProgress: progress.report }),
        },
      );
      const toolResult = catalog.toolResult(
        capabilityId,
        result as Readonly<Record<string, unknown>>,
        server.protocolVersionFor(extra),
      );
      // The latest held report still precedes a successful result.
      progress?.finish();
      return toolResult;
    } catch (error) {
      return errorResult(error);
    } finally {
      progress?.close();
    }
  });

  return server;
}
