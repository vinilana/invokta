import type { CapabilityMap, Engine, Principal } from "@ai-engine/core";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createMcpServer } from "./protocol-server.js";

export interface ServeMcpStdioOptions {
  readonly principal?: Principal | null;
}

export async function serveMcpStdio<Capabilities extends CapabilityMap>(
  engine: Engine<Capabilities>,
  options: ServeMcpStdioOptions = {},
): Promise<void> {
  const server = createMcpServer(engine, {
    principal: options.principal ?? null,
  });
  await server.connect(new StdioServerTransport());
}
