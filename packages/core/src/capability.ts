import type { EngineSchema } from "./schema.js";
import type { CapabilityDefinition } from "./types.js";

export function defineCapability<
  const InputSchema extends EngineSchema,
  const OutputSchema extends EngineSchema,
>(
  definition: CapabilityDefinition<InputSchema, OutputSchema>,
): CapabilityDefinition<InputSchema, OutputSchema> {
  return definition;
}
