import { createEngine, defineCapability } from "@invokta/core";
import { z } from "zod";

const capability = defineCapability({
  description: "Returns a valid MCP fixture result.",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  access: "public",
  async run() {
    return { ok: true };
  },
});

export const engine = createEngine({
  name: "valid-mcp-engine",
  version: "0.1.0",
  capabilities: {
    "support.echo": capability,
    "tasks.list": capability,
  },
});

export const supportEngine = engine;
