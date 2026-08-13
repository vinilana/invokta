import { createEngine, defineCapability } from "@invokta/core";
import { z } from "zod";

const capability = defineCapability({
  description: "Creates an MCP tool-name collision fixture.",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  access: "public",
  async run() {
    return { ok: true };
  },
});

export const engine = createEngine({
  name: "colliding-mcp-engine",
  version: "0.1.0",
  capabilities: {
    "support.echo": capability,
    support_echo: capability,
  },
});
