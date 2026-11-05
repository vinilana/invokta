import type {
  CapabilityErrorDescription,
  CapabilityErrorMap,
} from "./capability-error.js";
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

export type ExecutionSource =
  | "direct"
  | "cli"
  | "mcp-stdio"
  | "mcp-http"
  | "http";

export interface EngineLogger {
  debug(message: string, details?: Readonly<Record<string, unknown>>): void;
  info(message: string, details?: Readonly<Record<string, unknown>>): void;
  warn(message: string, details?: Readonly<Record<string, unknown>>): void;
  error(message: string, details?: Readonly<Record<string, unknown>>): void;
}

/**
 * One advisory progress report. `progress` is a finite number of at least
 * zero that increases with every delivered report; `total` is a finite
 * positive number when known; `message` has at most 1,024 UTF-16 code units.
 */
export interface ProgressReport {
  readonly progress: number;
  readonly total?: number;
  readonly message?: string;
}

export interface ExecutionContext {
  readonly requestId: string;
  readonly source: ExecutionSource;
  readonly principal: Principal | null;
  readonly signal: AbortSignal;
  readonly logger: EngineLogger;
  /**
   * Reports advisory progress to the caller's progress sink, if any. It never
   * throws, never waits for the sink, and drops invalid, non-increasing, or
   * late reports. Reports from an access rule are ignored.
   */
  readonly reportProgress: (report: ProgressReport) => void;
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

/**
 * Optional public deprecation notice for one capability. Invocation behavior
 * does not change; adapters surface the notice to consumers.
 */
export interface CapabilityDeprecation {
  /** Why consumers should stop using the capability (1-1,024 characters). */
  readonly reason: string;
  /** The engine version that deprecated the capability (1-64 characters). */
  readonly since?: string;
  /** What consumers should use instead, usually a capability ID (1-256 characters). */
  readonly replacement?: string;
}

/** The published kind of a capability access rule. A function rule is opaque. */
export type CapabilityAccessKind = "public" | "authenticated" | "function";

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
  readonly deprecated?: CapabilityDeprecation;
  readonly errors?: CapabilityErrorMap;
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
  readonly deprecated?: CapabilityDeprecation;
  readonly errors?: CapabilityErrorMap;
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
      readonly domainCode?: string;
    };

export interface CapabilitySummary {
  readonly id: string;
  readonly title?: string;
  readonly description: string;
  readonly annotations?: CapabilityAnnotations;
  readonly deprecated?: CapabilityDeprecation;
}

export interface CapabilityDescription extends CapabilitySummary {
  readonly access: CapabilityAccessKind;
  readonly inputSchema: EngineJsonSchema;
  readonly outputSchema: EngineJsonSchema;
  readonly timeoutMs?: number;
  readonly errors?: ReadonlyArray<CapabilityErrorDescription>;
}

export interface InvokeOptions {
  readonly requestId?: string;
  readonly source?: ExecutionSource;
  readonly principal?: Principal | null;
  readonly signal?: AbortSignal;
  /**
   * Receives a frozen snapshot of every accepted progress report while `run`
   * is active. Failures and returned promises never change the invocation.
   */
  readonly onProgress?: (report: ProgressReport) => void | Promise<void>;
}
