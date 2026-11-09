import { pathToFileURL } from "node:url";

import { type McpHttpServerHandle, serveMcpHttp } from "@invokta/mcp";

import { createCrmEngine } from "./upstreams/crm-engine.js";

export interface CrmMcpHttpOptions {
  /** The service token the vendor issued to the gateway. */
  readonly serviceToken: string;
  readonly port?: number;
}

/** Serves the vendor's 200-tool CRM as its own MCP server. */
export function startCrmMcpHttp(
  options: CrmMcpHttpOptions,
): Promise<McpHttpServerHandle> {
  if (options.serviceToken.length < 16) {
    throw new TypeError("The CRM service token needs at least 16 characters.");
  }
  const expected = `Bearer ${options.serviceToken}`;
  return serveMcpHttp(createCrmEngine(), {
    port: options.port ?? 3401,
    auth: {
      mode: "required",
      authenticate: ({ headers }) =>
        headers.get("authorization") === expected
          ? { id: "acme-gateway" }
          : null,
    },
  });
}

async function main(): Promise<void> {
  const serviceToken = process.env.CRM_SERVICE_TOKEN;
  if (serviceToken === undefined || serviceToken === "") {
    throw new Error("CRM_SERVICE_TOKEN is required.");
  }
  const server = await startCrmMcpHttp({
    serviceToken,
    port: Number(process.env.CRM_PORT ?? 3401),
  });
  const { host, port } = server.address();
  process.stderr.write(
    `vendor CRM MCP server on http://${host}:${String(port)}/mcp\n`,
  );
  const stop = (): void => {
    void server.close().then(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  await main().catch((error: unknown) => {
    process.stderr.write(
      `vendor CRM server failed: ${error instanceof Error ? error.message : "unexpected failure"}\n`,
    );
    process.exitCode = 1;
  });
}
