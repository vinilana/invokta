import { pathToFileURL } from "node:url";

import {
  apiKeyAuthenticator,
  type DiscoveryRanker,
  type GatewayAuthenticator,
} from "@invokta/gateway";
import {
  connectMcpClient,
  type McpClientConnection,
  type McpHttpServerHandle,
  serveMcpHttp,
} from "@invokta/mcp";

import { parseApiKeys } from "./access/api-keys.js";
import { type CrmGatewayOptions, createCrmGateway } from "./gateway.js";
import { portugueseGlossaryRanker } from "./ranking/portuguese-glossary.js";

export interface CrmGatewayServerOptions {
  readonly crmUrl: string;
  readonly crmServiceToken: string;
  readonly authenticate: GatewayAuthenticator;
  readonly catalogPin?: string;
  readonly rank?: DiscoveryRanker;
  readonly catalogPort?: number;
  readonly discoveryPort?: number;
  readonly onDecision?: CrmGatewayOptions["onDecision"];
  readonly onSearch?: CrmGatewayOptions["onSearch"];
}

export interface CrmGatewayServers {
  /** The full catalog at `/mcp`, filtered per caller. */
  readonly catalog: McpHttpServerHandle;
  /** Three discovery tools plus `alwaysList` at `/search/mcp`. */
  readonly discovery: McpHttpServerHandle;
  readonly catalogFingerprint: string;
  close(): Promise<void>;
}

export async function startCrmGateway(
  options: CrmGatewayServerOptions,
): Promise<CrmGatewayServers> {
  let crm: McpClientConnection | undefined;
  let catalog: McpHttpServerHandle | undefined;
  try {
    crm = await connectMcpClient({
      transport: "http",
      url: options.crmUrl,
      authentication: { type: "bearer", token: options.crmServiceToken },
    });
    const built = await createCrmGateway({
      crm,
      ...(options.catalogPin === undefined
        ? {}
        : { catalogPin: options.catalogPin }),
      ...(options.rank === undefined ? {} : { rank: options.rank }),
      ...(options.onDecision === undefined
        ? {}
        : { onDecision: options.onDecision }),
      ...(options.onSearch === undefined ? {} : { onSearch: options.onSearch }),
    });
    const auth = {
      mode: "required",
      authenticate: options.authenticate,
    } as const;
    catalog = await serveMcpHttp(built.catalogEngine, {
      port: options.catalogPort ?? 3400,
      auth,
      visibility: built.gateway.visibility,
    });
    const discovery = await serveMcpHttp(built.discoveryEngine, {
      port: options.discoveryPort ?? 3402,
      path: "/search/mcp",
      auth,
      visibility: built.discovery.visibility,
    });
    const connection = crm;
    const catalogServer = catalog;
    return {
      catalog: catalogServer,
      discovery,
      catalogFingerprint: built.catalogFingerprint,
      async close() {
        await Promise.allSettled([catalogServer.close(), discovery.close()]);
        await connection.close();
      },
    };
  } catch (error) {
    // Release whatever started before the failure.
    await catalog?.close().catch(() => undefined);
    await crm?.close().catch(() => undefined);
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
  const ranker = process.env.DISCOVERY_RANKER;
  if (ranker !== undefined && ranker !== "portuguese-glossary") {
    throw new Error("DISCOVERY_RANKER accepts only portuguese-glossary.");
  }
  const servers = await startCrmGateway({
    crmUrl: process.env.CRM_MCP_URL ?? "http://127.0.0.1:3401/mcp",
    crmServiceToken: required("CRM_SERVICE_TOKEN"),
    authenticate: apiKeyAuthenticator({
      keys: parseApiKeys(required("GATEWAY_API_KEYS")),
    }),
    ...(process.env.CRM_CATALOG_PIN === undefined
      ? {}
      : { catalogPin: process.env.CRM_CATALOG_PIN }),
    ...(ranker === undefined ? {} : { rank: portugueseGlossaryRanker }),
    // One JSON line per decision and search, without payloads or the query.
    onDecision: (decision) => {
      process.stderr.write(`${JSON.stringify({ decision })}\n`);
    },
    onSearch: (search) => {
      process.stderr.write(`${JSON.stringify({ search })}\n`);
    },
  });
  const catalog = servers.catalog.address();
  const discovery = servers.discovery.address();
  process.stderr.write(
    [
      `full catalog:  http://${catalog.host}:${String(catalog.port)}/mcp`,
      `discovery:     http://${discovery.host}:${String(discovery.port)}/search/mcp`,
      `catalog fingerprint (set CRM_CATALOG_PIN to pin it): ${servers.catalogFingerprint}`,
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
