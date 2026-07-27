import {
  type CapabilityAnnotations,
  type CapabilityMap,
  type Engine,
  EngineError,
  type EngineJsonSchema,
  type ExecutionSource,
  type Principal,
} from "@ai-engine/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

interface McpServerOptions {
  readonly principal: Principal | null;
  readonly source: Extract<ExecutionSource, "mcp-stdio" | "mcp-http">;
  readonly requestSignal?: AbortSignal;
}

interface McpObjectSchema extends Readonly<Record<string, unknown>> {
  readonly type: "object";
}

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

function safeEngineError(error: unknown): {
  readonly code: string;
  readonly message: string;
  readonly publicDetails?: unknown;
} {
  if (!(error instanceof EngineError)) {
    return {
      code: "EXECUTION_FAILED",
      message: "Capability execution failed.",
    };
  }
  return {
    code: error.code,
    message: error.message,
    ...(error.publicDetails === undefined
      ? {}
      : { publicDetails: error.publicDetails }),
  };
}

function safeJson(value: unknown, fallback: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify(fallback);
  }
}

function errorResult(error: unknown) {
  const safeError = safeEngineError(error);
  return {
    isError: true as const,
    content: [
      {
        type: "text" as const,
        text: safeJson(safeError, {
          code: safeError.code,
          message: safeError.message,
        }),
      },
    ],
  };
}

export function createMcpServer<Capabilities extends CapabilityMap>(
  engine: Engine<Capabilities>,
  options: McpServerOptions,
): Server {
  const capabilityIds = new Set(engine.list().map(({ id }) => id));
  const server = new Server(
    { name: engine.name, version: engine.version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: engine.list().map((summary) => {
      const capabilityId = summary.id as Extract<keyof Capabilities, string>;
      const description = engine.describe(capabilityId);
      const annotations = mapAnnotations(description.annotations);
      return {
        name: description.id,
        description: description.description,
        inputSchema: asObjectSchema(description.inputSchema),
        outputSchema: asObjectSchema(description.outputSchema),
        ...(description.title === undefined
          ? {}
          : { title: description.title }),
        ...(annotations === undefined ? {} : { annotations }),
      };
    }),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (!capabilityIds.has(request.params.name)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Tool ${request.params.name} not found`,
      );
    }
    const capabilityId = request.params.name as Extract<
      keyof Capabilities,
      string
    >;
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
