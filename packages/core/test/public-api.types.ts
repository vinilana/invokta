import { expectTypeOf } from "vitest";
import { z } from "zod";

import {
  type AccessRule,
  CapabilityError,
  type CapabilityErrorMap,
  type CapabilityErrorDescription,
  type CapabilityDescription,
  type ConnectorConfigSchema,
  createEngine,
  defineCapability,
  defineConnector,
  type DomainErrorPublicDetails,
  type EngineErrorCode,
  type EngineEvent,
  type InferSchemaInput,
  type InferSchemaOutput,
} from "../src/index.js";

// @ts-expect-error Connector configuration must validate to an object root.
const scalarConnectorConfig: ConnectorConfigSchema = z.string();
void scalarConnectorConfig;

const typedConnector = defineConnector({
  name: "typed-reader",
  config: z.object({
    limit: z.string().transform((value) => Number(value)),
  }),
  create(config, dependencies: { readonly prefix: string }) {
    expectTypeOf(config).toEqualTypeOf<{ limit: number }>();
    expectTypeOf(dependencies).toEqualTypeOf<{
      readonly prefix: string;
    }>();
    return {
      ports: {
        reader: {
          read: () => `${dependencies.prefix}:${String(config.limit)}`,
        },
      },
    };
  },
});

expectTypeOf(typedConnector.name).toEqualTypeOf<"typed-reader">();
const typedConnectorInstance = typedConnector.create(
  { limit: "2" },
  { prefix: "items" },
);
expectTypeOf(
  typedConnectorInstance.ports.reader.read(),
).toEqualTypeOf<string>();

// @ts-expect-error Connector creation accepts the configuration schema input.
typedConnector.create({ limit: 2 }, { prefix: "items" });

// @ts-expect-error Connector dependencies are explicit and required.
typedConnector.create({ limit: "2" });

// @ts-expect-error Connector instances expose only their declared named ports.
typedConnectorInstance.ports.writer;

const input = z.object({
  value: z.string().transform((value) => value.length),
});
const output = z.object({
  result: z.string().transform((value) => value.toUpperCase()),
});

expectTypeOf<InferSchemaInput<typeof input>>().toEqualTypeOf<{
  value: string;
}>();
expectTypeOf<InferSchemaOutput<typeof input>>().toEqualTypeOf<{
  value: number;
}>();

const access: AccessRule<{ value: number }> = ({
  principal,
  input,
  context,
  capabilityId,
}) => {
  expectTypeOf(principal).toEqualTypeOf<Readonly<{
    id: string;
    attributes?: Readonly<Record<string, unknown>>;
  }> | null>();
  expectTypeOf(input).toEqualTypeOf<{ value: number }>();
  expectTypeOf(context.source).toEqualTypeOf<
    "direct" | "cli" | "mcp-stdio" | "mcp-http"
  >();
  expectTypeOf(capabilityId).toEqualTypeOf<string>();
  return true;
};

const engine = createEngine({
  name: "types-engine",
  version: "0.1.0",
  capabilities: {
    "example.transform": defineCapability({
      description: "Prove public input and output inference.",
      input,
      output,
      access,
      async run({ input }) {
        expectTypeOf(input).toEqualTypeOf<{ value: number }>();
        return { result: String(input.value) };
      },
    }),
  },
});

expectTypeOf(engine.name).toEqualTypeOf<string>();
expectTypeOf(
  engine.invoke("example.transform", { value: "four" }),
).resolves.toEqualTypeOf<{ result: string }>();

// @ts-expect-error Unknown capability IDs are rejected for typed engines.
engine.invoke("example.missing", { value: "four" });

// @ts-expect-error Invocation input uses the schema input type, not its output type.
engine.invoke("example.transform", { value: 4 });

const scheduleErrors = {
  SLOT_CONFLICT: {
    description: "The requested slot is no longer available.",
    details: z.object({
      slotId: z.string(),
      attempts: z.string().transform((value) => Number(value)),
    }),
  },
  CALENDAR_UNAVAILABLE: {
    description: "The calendar provider is temporarily unavailable.",
    retryable: true,
  },
} satisfies CapabilityErrorMap;

new CapabilityError<typeof scheduleErrors>("SLOT_CONFLICT", {
  details: { slotId: "S-1", attempts: "2" },
  cause: new Error("internal"),
});
new CapabilityError<typeof scheduleErrors>("CALENDAR_UNAVAILABLE");
new CapabilityError<typeof scheduleErrors>("CALENDAR_UNAVAILABLE", {
  cause: new Error("internal"),
});
new CapabilityError("ANY_DECLARED_CODE", { details: { anything: true } });
expectTypeOf(
  new CapabilityError<typeof scheduleErrors>("CALENDAR_UNAVAILABLE").code,
).toEqualTypeOf<"SLOT_CONFLICT" | "CALENDAR_UNAVAILABLE">();
expectTypeOf(new CapabilityError("ANY").code).toEqualTypeOf<string>();

// @ts-expect-error Typed domain errors reject undeclared codes.
new CapabilityError<typeof scheduleErrors>("UNDECLARED");

// @ts-expect-error A declared details schema makes details required.
new CapabilityError<typeof scheduleErrors>("SLOT_CONFLICT");

// @ts-expect-error Details use the input type of the declared schema.
new CapabilityError<typeof scheduleErrors>("SLOT_CONFLICT", {
  details: { slotId: "S-1", attempts: 2 },
});

// @ts-expect-error A declaration without a details schema accepts no details.
new CapabilityError<typeof scheduleErrors>("CALENDAR_UNAVAILABLE", {
  details: { slotId: "S-1" },
});

const scheduleCapability = defineCapability({
  description: "Schedule an appointment in a free slot.",
  input: z.object({ slotId: z.string() }),
  output: z.object({ confirmed: z.boolean() }),
  access: "public",
  errors: scheduleErrors,
  async run({ input }) {
    if (input.slotId === "taken") {
      throw new CapabilityError<typeof scheduleErrors>("SLOT_CONFLICT", {
        details: { slotId: input.slotId, attempts: "1" },
      });
    }
    return { confirmed: true };
  },
});
void scheduleCapability;

defineCapability({
  description: "Reject a malformed domain error declaration.",
  input: z.object({}),
  output: z.object({}),
  access: "public",
  // @ts-expect-error Domain error retryable flags are booleans.
  errors: { BROKEN: { description: "Broken.", retryable: "yes" } },
  async run() {
    return {};
  },
});

expectTypeOf<"DOMAIN_ERROR">().toExtend<EngineErrorCode>();
expectTypeOf<CapabilityDescription["errors"]>().toEqualTypeOf<
  ReadonlyArray<CapabilityErrorDescription> | undefined
>();
expectTypeOf<DomainErrorPublicDetails>().toEqualTypeOf<{
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
}>();
expectTypeOf<
  Extract<EngineEvent, { type: "invocation.failed" }>["domainCode"]
>().toEqualTypeOf<string | undefined>();
