import { pathToFileURL } from "node:url";

import type { GatewayAuthenticator } from "@invokta/gateway";
import { type HttpServerHandle, serveHttp } from "@invokta/http/node";
import {
  connectMcpClient,
  type McpClientConnection,
  type McpHttpServerHandle,
  serveMcpHttp,
} from "@invokta/mcp";

import {
  createGatewayAuthenticator,
  createJwtMethod,
  parseApiKeys,
  readJwtSettings,
} from "./access/authenticate.js";
import { createAcmeGateway } from "./gateway.js";

export interface AcmeGatewayServerOptions {
  readonly docsUrl: string;
  readonly docsServiceToken: string;
  readonly authenticate: GatewayAuthenticator;
  readonly docsCatalogPin?: string;
  readonly mcpPort?: number;
  readonly httpPort?: number;
  readonly onDecision?: Parameters<typeof createAcmeGateway>[0]["onDecision"];
}

export interface AcmeGatewayServers {
  readonly mcp: McpHttpServerHandle;
  readonly http: HttpServerHandle;
  readonly docsFingerprint: string;
  close(): Promise<void>;
}

/**
 * Connects to the docs MCP server with the gateway's service credential and
 * serves the gateway twice: MCP HTTP for agents and plain HTTP JSON for
 * applications. Both adapters authenticate every request and list only the
 * capabilities the caller's rules can allow.
 */
export async function startAcmeGateway(
  options: AcmeGatewayServerOptions,
): Promise<AcmeGatewayServers> {
  let docs: McpClientConnection | undefined;
  let mcp: McpHttpServerHandle | undefined;
  try {
    docs = await connectMcpClient({
      transport: "http",
      url: options.docsUrl,
      authentication: { type: "bearer", token: options.docsServiceToken },
    });
    const { gateway, engine, docsFingerprint } = await createAcmeGateway({
      docs,
      ...(options.docsCatalogPin === undefined
        ? {}
        : { docsCatalogPin: options.docsCatalogPin }),
      ...(options.onDecision === undefined
        ? {}
        : { onDecision: options.onDecision }),
    });
    const auth = {
      mode: "required",
      authenticate: options.authenticate,
    } as const;
    mcp = await serveMcpHttp(engine, {
      port: options.mcpPort ?? 3300,
      auth,
      visibility: gateway.visibility,
    });
    const http = await serveHttp(engine, {
      port: options.httpPort ?? 3302,
      auth,
      visibility: gateway.visibility,
    });
    const connection = docs;
    const mcpServer = mcp;
    return {
      mcp: mcpServer,
      http,
      docsFingerprint,
      async close() {
        await Promise.allSettled([mcpServer.close(), http.close()]);
        await connection.close();
      },
    };
  } catch (error) {
    // Release whatever started before the failure.
    await mcp?.close().catch(() => undefined);
    await docs?.close().catch(() => undefined);
    throw error;
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required.`);
  }
  return value;
}

async function main(): Promise<void> {
  const apiKeys = process.env.GATEWAY_API_KEYS;
  const jwt = readJwtSettings(process.env);
  const servers = await startAcmeGateway({
    docsUrl: process.env.DOCS_MCP_URL ?? "http://127.0.0.1:3301/mcp",
    docsServiceToken: required("DOCS_SERVICE_TOKEN"),
    authenticate: createGatewayAuthenticator({
      ...(apiKeys === undefined || apiKeys === ""
        ? {}
        : { apiKeys: parseApiKeys(apiKeys) }),
      ...(jwt === undefined ? {} : { jwt: createJwtMethod(jwt) }),
    }),
    ...(process.env.DOCS_CATALOG_PIN === undefined
      ? {}
      : { docsCatalogPin: process.env.DOCS_CATALOG_PIN }),
    onDecision: (decision) => {
      process.stderr.write(`${JSON.stringify({ decision })}\n`);
    },
  });
  const mcp = servers.mcp.address();
  const http = servers.http.address();
  process.stderr.write(
    [
      `gateway MCP endpoint:  http://${mcp.host}:${String(mcp.port)}/mcp`,
      `gateway HTTP endpoint: http://${http.host}:${String(http.port)}/capabilities`,
      `docs catalog fingerprint (set DOCS_CATALOG_PIN to pin it): ${servers.docsFingerprint}`,
      "",
    ].join("\n"),
  );
  const stop = (): void => {
    void servers.close().then(() => process.exit(0));
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
      `gateway failed to start: ${error instanceof Error ? error.message : "unexpected failure"}\n`,
    );
    process.exitCode = 1;
  });
}
