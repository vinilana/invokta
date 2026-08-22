import { expectTypeOf } from "vitest";
import { z } from "zod";

import {
  type AccessRule,
  createEngine,
  defineCapability,
  defineConnector,
  type InferSchemaInput,
  type InferSchemaOutput,
} from "../src/index.js";

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
