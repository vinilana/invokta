import { createEngine, defineCapability } from "@ai-engine/core";
import { z } from "zod";
import { serveMcpStdio } from "../../dist/index.js";

const engine = createEngine({
  name: "stdio-smoke-engine",
  version: "0.1.0",
  capabilities: {
    "example.inspect-context": defineCapability({
      description: "Returns the stdio execution boundary context.",
      input: z.object({ value: z.string() }),
      output: z.object({
        value: z.string(),
        source: z.literal("mcp-stdio"),
        anonymous: z.boolean(),
      }),
      access: "public",
      async run({ input, context }) {
        return {
          value: input.value,
          source: context.source,
          anonymous: context.principal === null,
        };
      },
    }),
  },
});

await serveMcpStdio(engine);
