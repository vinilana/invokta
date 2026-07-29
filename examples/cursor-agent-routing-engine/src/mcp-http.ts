import { pathToFileURL } from "node:url";

import { type McpHttpServerHandle, serveMcpHttp } from "@invokta/mcp";

import { engine } from "./engine.js";

export interface CursorRoutingMcpHttpOptions {
  readonly expectedBearerToken: string;
  readonly host?: string;
  readonly port?: number;
}

export async function startCursorRoutingMcpHttp(
  options: CursorRoutingMcpHttpOptions,
): Promise<McpHttpServerHandle> {
  return serveMcpHttp(engine, {
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.port === undefined ? {} : { port: options.port }),
    auth: {
      mode: "required",
      authenticate(request) {
        return request.headers.get("authorization") ===
          `Bearer ${options.expectedBearerToken}`
          ? { id: "cursor-routing:http-client" }
          : null;
      },
    },
  });
}

export async function main(): Promise<McpHttpServerHandle> {
  const expectedBearerToken = process.env.CURSOR_ROUTING_ENGINE_BEARER_TOKEN;
  if (expectedBearerToken === undefined || expectedBearerToken === "") {
    throw new Error("CURSOR_ROUTING_ENGINE_BEARER_TOKEN is required.");
  }
  const configuredPort = process.env.PORT;
  const port = configuredPort === undefined ? 3000 : Number(configuredPort);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("PORT must be an integer between 0 and 65535.");
  }
  return startCursorRoutingMcpHttp({ expectedBearerToken, port });
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  await main()
    .then((server) => {
      const address = server.address();
      process.stderr.write(
        `Cursor agent routing MCP HTTP adapter listening on host ${address.host}, port ${address.port}\n`,
      );
    })
    .catch(() => {
      process.stderr.write(
        "Cursor agent routing MCP HTTP adapter failed to start.\n",
      );
      process.exitCode = 1;
    });
}
