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
