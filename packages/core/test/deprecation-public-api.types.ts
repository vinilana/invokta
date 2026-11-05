import { expectTypeOf } from "vitest";
import { z } from "zod";

import {
  type CapabilityAccessKind,
  type CapabilityDeprecation,
  type CapabilityDescription,
  type CapabilitySummary,
  createEngine,
  defineCapability,
} from "../src/index.js";

const input = z.object({ value: z.string() });
const output = z.object({ result: z.string() });

expectTypeOf<CapabilityDeprecation>().toEqualTypeOf<{
  readonly reason: string;
  readonly since?: string;
  readonly replacement?: string;
}>();
expectTypeOf<CapabilityAccessKind>().toEqualTypeOf<
  "public" | "authenticated" | "function"
>();
expectTypeOf<CapabilitySummary["deprecated"]>().toEqualTypeOf<
  CapabilityDeprecation | undefined
>();
expectTypeOf<
  CapabilityDescription["access"]
>().toEqualTypeOf<CapabilityAccessKind>();

const legacy = defineCapability({
  description: "A deprecated capability keeps its inferred contract.",
  input,
  output,
  access: "public",
  deprecated: {
    reason: "Superseded by support.triage.",
    since: "2.0.0",
    replacement: "support.triage",
  },
  async run({ input }) {
    expectTypeOf(input).toEqualTypeOf<{ value: string }>();
    return { result: input.value };
  },
});

const engine = createEngine({
  name: "deprecation-types-engine",
  version: "2.0.0",
  capabilities: { legacy },
});

expectTypeOf(engine.describe("legacy").deprecated).toEqualTypeOf<
  CapabilityDeprecation | undefined
>();
expectTypeOf(engine.describe("legacy").access).toEqualTypeOf<
  "public" | "authenticated" | "function"
>();

defineCapability({
  description: "A deprecation notice requires a reason.",
  input,
  output,
  access: "public",
  // @ts-expect-error The reason is required.
  deprecated: { since: "2.0.0" },
  async run({ input }) {
    return { result: input.value };
  },
});

defineCapability({
  description: "Deprecation is a structured notice, not a flag.",
  input,
  output,
  access: "public",
  // @ts-expect-error A boolean flag does not explain the deprecation.
  deprecated: true,
  async run({ input }) {
    return { result: input.value };
  },
});
