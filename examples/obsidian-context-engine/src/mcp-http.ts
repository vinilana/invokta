import { pathToFileURL } from "node:url";

import { type McpHttpServerHandle, serveMcpHttp } from "@ai-engine/mcp";

import { createConfiguredObsidianContextEngine } from "./engine.js";
import { localPrincipal } from "./local-principal.js";

export interface ObsidianContextMcpHttpOptions {
  readonly expectedBearerToken: string;
  readonly host?: string;
  readonly port?: number;
}

export async function startObsidianContextMcpHttp(
  options: ObsidianContextMcpHttpOptions,
): Promise<McpHttpServerHandle> {
  if (options.expectedBearerToken === "") {
    throw new TypeError("A bearer token is required.");
  }
  return serveMcpHttp(createConfiguredObsidianContextEngine(), {
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.port === undefined ? {} : { port: options.port }),
    auth: {
      mode: "required",
      authenticate(request) {
        return request.headers.get("authorization") ===
          `Bearer ${options.expectedBearerToken}`
          ? localPrincipal
          : null;
      },
    },
  });
}

export async function main(): Promise<McpHttpServerHandle> {
  const expectedBearerToken = process.env.OBSIDIAN_ENGINE_BEARER_TOKEN;
  if (expectedBearerToken === undefined || expectedBearerToken === "") {
    throw new Error("OBSIDIAN_ENGINE_BEARER_TOKEN is required.");
  }
  const configuredPort = process.env.PORT;
  const port = configuredPort === undefined ? 3000 : Number(configuredPort);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("PORT must be an integer between 0 and 65535.");
  }
  return startObsidianContextMcpHttp({ expectedBearerToken, port });
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
        `Obsidian context engine MCP HTTP adapter listening on host ${address.host}, port ${String(address.port)}\n`,
      );
    })
    .catch(() => {
      process.stderr.write(
        "Obsidian context engine MCP HTTP adapter failed to start.\n",
      );
      process.exitCode = 1;
    });
}
