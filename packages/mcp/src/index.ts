import type { CapabilityMap, Engine, Principal } from "@ai-engine/core";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export {
  type McpHttpAuthenticationRequest,
  type McpHttpAuthOptions,
  type McpHttpHeaderView,
  type McpHttpProtectedResourceMetadata,
  type McpHttpServerAddress,
  type McpHttpServerHandle,
  type ServeMcpHttpOptions,
  serveMcpHttp,
} from "./http.js";

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
    source: "mcp-stdio",
  });
  await server.connect(new StdioServerTransport());
}
