import { pathToFileURL } from "node:url";

import { type McpHttpServerHandle, serveMcpHttp } from "@invokta/mcp";

import { createDocsEngine } from "./upstreams/docs-engine.js";

export interface DocsMcpHttpOptions {
  /** The only credential the upstream accepts: the gateway's service token. */
  readonly serviceToken: string;
  readonly port?: number;
}

/**
 * Serves the documentation engine as a separate MCP server, the way another
 * team would operate it. Only the gateway holds its service token, so end
 * users can reach it only through the gateway's rules.
 */
export function startDocsMcpHttp(
  options: DocsMcpHttpOptions,
): Promise<McpHttpServerHandle> {
  if (options.serviceToken.length < 16) {
    throw new TypeError("The docs service token needs at least 16 characters.");
  }
  const expected = `Bearer ${options.serviceToken}`;
  return serveMcpHttp(createDocsEngine(), {
    port: options.port ?? 3301,
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
  const serviceToken = process.env.DOCS_SERVICE_TOKEN;
  if (serviceToken === undefined || serviceToken === "") {
    throw new Error("DOCS_SERVICE_TOKEN is required.");
  }
  const server = await startDocsMcpHttp({
    serviceToken,
    port: Number(process.env.DOCS_PORT ?? 3301),
  });
  const { host, port } = server.address();
  process.stderr.write(
    `docs MCP server on http://${host}:${String(port)}/mcp\n`,
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
      `docs MCP server failed: ${error instanceof Error ? error.message : "unexpected failure"}\n`,
    );
    process.exitCode = 1;
  });
}
