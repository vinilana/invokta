import { expectTypeOf } from "vitest";
import { z } from "zod";

import {
  applyMiddleware,
  type CapabilityMiddleware,
  type CapabilityMiddlewareArgs,
  type ComposedCapabilities,
  composeCapabilities,
  createEngine,
  defineCapability,
  type ExecutionContext,
} from "../src/index.js";

const classifyTicket = defineCapability({
  description: "Classify a support ticket.",
  input: z.object({
    ticketId: z.string().transform((ticketId) => ticketId.length),
  }),
  output: z.object({ category: z.string() }),
  access: "public",
  async run({ input }) {
    expectTypeOf(input).toEqualTypeOf<{ ticketId: number }>();
    return { category: String(input.ticketId) };
  },
});

const audit: CapabilityMiddleware = async ({
  capabilityId,
  input,
  context,
  next,
}) => {
  expectTypeOf(capabilityId).toEqualTypeOf<string>();
  expectTypeOf(input).toEqualTypeOf<unknown>();
  expectTypeOf(context).toEqualTypeOf<ExecutionContext>();
  expectTypeOf(next).toEqualTypeOf<() => Promise<unknown>>();
  return next();
};

expectTypeOf<CapabilityMiddleware>().toEqualTypeOf<
  (args: CapabilityMiddlewareArgs) => Promise<unknown>
>();

// A plain map keeps its literal IDs and schema-derived invocation types.
const wrapped = applyMiddleware(
  { "support.classify-ticket": classifyTicket },
  audit,
);
expectTypeOf(wrapped).toEqualTypeOf<{
  readonly "support.classify-ticket": typeof classifyTicket;
}>();

const engine = createEngine({
  name: "middleware-types-engine",
  version: "1.0.0",
  capabilities: wrapped,
});
expectTypeOf(
  engine.invoke("support.classify-ticket", { ticketId: "T-1" }),
).resolves.toEqualTypeOf<{ category: string }>();

// @ts-expect-error Unknown capability IDs remain rejected after wrapping.
engine.invoke("support.missing", { ticketId: "T-1" });

// @ts-expect-error Invocation input still uses the schema input type.
engine.invoke("support.classify-ticket", { ticketId: 1 });

// A composed map keeps its composition type.
const composed = composeCapabilities({
  local: { "support.classify-ticket": classifyTicket },
});
const wrappedComposed = applyMiddleware(composed, audit, audit);
expectTypeOf(wrappedComposed).toEqualTypeOf<typeof composed>();
expectTypeOf(wrappedComposed).toExtend<ComposedCapabilities>();

applyMiddleware(
  { "support.classify-ticket": classifyTicket },
  // @ts-expect-error Middleware must be a function.
  "audit",
);

applyMiddleware({ "support.classify-ticket": classifyTicket }, async (args) =>
  // @ts-expect-error next() accepts no replacement input or context.
  args.next({ ticketId: 1 }),
);

applyMiddleware(
  { "support.classify-ticket": classifyTicket },
  // @ts-expect-error Middleware returns a promise, like run.
  ({ next }) => {
    void next;
    return { category: "sync" };
  },
);
