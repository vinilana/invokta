import type { EngineErrorCode } from "./error.js";
import type {
  EngineJsonSchema,
  EngineSchema,
  InferSchemaInput,
  InferSchemaOutput,
} from "./schema.js";

export interface Principal {
  readonly id: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

export type ExecutionSource = "direct" | "cli" | "mcp-stdio" | "mcp-http";

export interface EngineLogger {
  debug(message: string, details?: Readonly<Record<string, unknown>>): void;
  info(message: string, details?: Readonly<Record<string, unknown>>): void;
  warn(message: string, details?: Readonly<Record<string, unknown>>): void;
  error(message: string, details?: Readonly<Record<string, unknown>>): void;
}

export interface ExecutionContext {
  readonly requestId: string;
  readonly source: ExecutionSource;
  readonly principal: Principal | null;
  readonly signal: AbortSignal;
  readonly logger: EngineLogger;
}

export type AccessRule<Input> =
  | "public"
  | "authenticated"
  | ((args: {
      readonly principal: Principal | null;
      readonly input: Input;
      readonly context: ExecutionContext;
      readonly capabilityId: string;
    }) => boolean | Promise<boolean>);

export interface CapabilityAnnotations {
  readonly readOnly?: boolean;
  readonly destructive?: boolean;
  readonly idempotent?: boolean;
  readonly openWorld?: boolean;
}

export interface CapabilityDefinition<
  InputSchema extends EngineSchema,
  OutputSchema extends EngineSchema,
> {
  readonly title?: string;
  readonly description: string;
  readonly input: InputSchema;
  readonly output: OutputSchema;
  readonly access: AccessRule<InferSchemaOutput<InputSchema>>;
  readonly timeoutMs?: number;
  readonly annotations?: CapabilityAnnotations;
  readonly run: (args: {
    readonly input: InferSchemaOutput<InputSchema>;
    readonly context: ExecutionContext;
  }) => Promise<InferSchemaInput<OutputSchema>>;
}

export interface AnyCapability {
  readonly title?: string;
  readonly description: string;
  readonly input: EngineSchema;
  readonly output: EngineSchema;
  readonly access: AccessRule<never>;
  readonly timeoutMs?: number;
  readonly annotations?: CapabilityAnnotations;
  readonly run: (args: {
    readonly input: never;
    readonly context: ExecutionContext;
  }) => Promise<unknown>;
}

export type CapabilityMap = Readonly<Record<string, AnyCapability>>;

export type EngineEvent =
  | {
      readonly type: "invocation.started";
      readonly requestId: string;
      readonly capabilityId: string;
      readonly source: ExecutionSource;
      readonly principalId?: string;
      readonly startedAt: string;
    }
  | {
      readonly type: "invocation.completed";
      readonly requestId: string;
      readonly capabilityId: string;
      readonly durationMs: number;
    }
  | {
      readonly type: "invocation.failed";
      readonly requestId: string;
      readonly capabilityId: string;
      readonly durationMs: number;
      readonly code: EngineErrorCode;
    };

export interface CapabilitySummary {
  readonly id: string;
  readonly title?: string;
  readonly description: string;
  readonly annotations?: CapabilityAnnotations;
}

export interface CapabilityDescription extends CapabilitySummary {
  readonly inputSchema: EngineJsonSchema;
  readonly outputSchema: EngineJsonSchema;
  readonly timeoutMs?: number;
}

export interface InvokeOptions {
  readonly requestId?: string;
  readonly source?: ExecutionSource;
  readonly principal?: Principal | null;
  readonly signal?: AbortSignal;
}
