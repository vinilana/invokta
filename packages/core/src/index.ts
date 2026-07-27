import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from "@standard-schema/spec";
import { randomUUID } from "node:crypto";

export interface EngineSchema<Input = unknown, Output = Input> {
  readonly "~standard": StandardSchemaV1.Props<Input, Output> &
    StandardJSONSchemaV1.Props<Input, Output>;
}

export type InferSchemaInput<Schema extends EngineSchema> =
  StandardSchemaV1.InferInput<Schema>;

export type InferSchemaOutput<Schema extends EngineSchema> =
  StandardSchemaV1.InferOutput<Schema>;

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

export type AccessRule = "public" | "authenticated";

export interface CapabilityDefinition<
  InputSchema extends EngineSchema,
  OutputSchema extends EngineSchema,
> {
  readonly description: string;
  readonly input: InputSchema;
  readonly output: OutputSchema;
  readonly access: AccessRule;
  readonly run: (request: {
    readonly input: InferSchemaOutput<InputSchema>;
    readonly context: ExecutionContext;
  }) => Promise<InferSchemaInput<OutputSchema>>;
}

export function defineCapability<
  const InputSchema extends EngineSchema,
  const OutputSchema extends EngineSchema,
>(
  definition: CapabilityDefinition<InputSchema, OutputSchema>,
): CapabilityDefinition<InputSchema, OutputSchema> {
  return definition;
}

interface CapabilityLike {
  readonly description: string;
  readonly input: EngineSchema;
  readonly output: EngineSchema;
  readonly access: AccessRule;
  readonly run: (request: {
    readonly input: never;
    readonly context: ExecutionContext;
  }) => unknown;
}

type CapabilityMap = Readonly<Record<string, CapabilityLike>>;

type CapabilityInput<Capability extends CapabilityLike> = InferSchemaInput<
  Capability["input"]
>;

type CapabilityOutput<Capability extends CapabilityLike> = InferSchemaOutput<
  Capability["output"]
>;

export interface EngineDefinition<Capabilities extends CapabilityMap> {
  readonly name: string;
  readonly version: string;
  readonly capabilities: Capabilities;
}

export interface InvokeOptions {
  readonly requestId?: string;
  readonly source?: ExecutionSource;
  readonly principal?: Principal | null;
  readonly signal?: AbortSignal;
}

export interface Engine<Capabilities extends CapabilityMap> {
  invoke<CapabilityId extends Extract<keyof Capabilities, string>>(
    capabilityId: CapabilityId,
    input: CapabilityInput<Capabilities[CapabilityId]>,
    options?: InvokeOptions,
  ): Promise<CapabilityOutput<Capabilities[CapabilityId]>>;
}

async function validate<Schema extends EngineSchema>(
  schema: Schema,
  value: unknown,
  message: string,
): Promise<InferSchemaOutput<Schema>> {
  const result = await schema["~standard"].validate(value);
  if (result.issues !== undefined) {
    throw new Error(message, { cause: result.issues });
  }
  return result.value;
}

const ignoreLog = (): void => undefined;
const noOpLogger: EngineLogger = Object.freeze({
  debug: ignoreLog,
  info: ignoreLog,
  warn: ignoreLog,
  error: ignoreLog,
});

export function createEngine<const Capabilities extends CapabilityMap>(
  definition: EngineDefinition<Capabilities>,
): Engine<Capabilities> {
  return {
    async invoke(capabilityId, input, options) {
      const capability = definition.capabilities[capabilityId];
      if (capability === undefined) {
        throw new Error("Capability not found.");
      }
      const validatedInput = await validate(
        capability.input,
        input,
        "Capability input validation failed.",
      );
      const principal = options?.principal ?? null;

      if (capability.access === "authenticated" && principal === null) {
        throw new Error("Authentication is required.");
      }

      const run = capability.run as (request: {
        readonly input: unknown;
        readonly context: ExecutionContext;
      }) => unknown;
      const output = await run({
        input: validatedInput,
        context: {
          requestId: options?.requestId ?? randomUUID(),
          source: options?.source ?? "direct",
          principal,
          signal: options?.signal ?? new AbortController().signal,
          logger: noOpLogger,
        },
      });

      return validate(
        capability.output,
        output,
        "Capability output validation failed.",
      ) as Promise<CapabilityOutput<Capabilities[typeof capabilityId]>>;
    },
  };
}
