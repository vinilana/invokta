import {
  type CapabilityAnnotations,
  type CapabilityMap,
  type Engine,
  EngineError,
  type EngineErrorCode,
  type EngineJsonSchema,
  type ExecutionSource,
  type Principal,
} from "@invokta/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

import { toMcpToolName } from "./tool-name.js";

interface McpServerOptions {
  readonly principal: Principal | null;
  readonly source: Extract<ExecutionSource, "mcp-stdio" | "mcp-http">;
  readonly requestSignal?: AbortSignal;
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
}

export interface McpToolCatalog<Capabilities extends CapabilityMap> {
  readonly tools: ReadonlyArray<McpToolDefinition>;
  capabilityIdForToolName(
    toolName: string,
  ): Extract<keyof Capabilities, string> | undefined;
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
    const annotations = mapAnnotations(description.annotations);
    return Object.freeze({
      name: toolName,
      description: description.description,
      inputSchema: asObjectSchema(description.inputSchema),
      outputSchema: asObjectSchema(description.outputSchema),
      ...(description.title === undefined ? {} : { title: description.title }),
      ...(annotations === undefined ? {} : { annotations }),
    });
  });
  const frozenTools = Object.freeze(tools);

  return Object.freeze({
    tools: frozenTools,
    capabilityIdForToolName: (toolName: string) =>
      capabilityIdByToolName.get(toolName),
  });
}

/** Validates the exact MCP tool catalog without starting an adapter. */
export function validateMcpToolCatalog<Capabilities extends CapabilityMap>(
  engine: Engine<Capabilities>,
): void {
  createMcpToolCatalog(engine);
}

export function createMcpServer<Capabilities extends CapabilityMap>(
  engine: Engine<Capabilities>,
  options: McpServerOptions,
  catalog: McpToolCatalog<Capabilities> = createMcpToolCatalog(engine),
): Server {
  const server = new Server(
    { name: engine.name, version: engine.version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: Array.from(catalog.tools),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const capabilityId = catalog.capabilityIdForToolName(request.params.name);
    if (capabilityId === undefined) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Tool ${request.params.name} not found`,
      );
    }
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
        },
      );
      const structuredContent = result as Readonly<Record<string, unknown>>;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(structuredContent),
          },
        ],
        structuredContent,
      };
    } catch (error) {
      return errorResult(error);
    }
  });

  return server;
}
