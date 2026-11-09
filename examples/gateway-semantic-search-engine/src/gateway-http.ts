import { pathToFileURL } from "node:url";

import {
  apiKeyAuthenticator,
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
import { createOpenAiCompatibleEmbedder } from "./infrastructure/openai-compatible-embedder.js";
import {
  createSemanticToolIndex,
  type SemanticToolIndex,
} from "./search/semantic-tool-index.js";

export interface CrmGatewayServerOptions {
  readonly crmUrl: string;
  readonly crmServiceToken: string;
  readonly authenticate: GatewayAuthenticator;
  readonly index: SemanticToolIndex;
  readonly catalogPin?: string;
  readonly catalogPort?: number;
  readonly discoveryPort?: number;
  readonly onDecision?: CrmGatewayOptions["onDecision"];
  readonly onSearch?: CrmGatewayOptions["onSearch"];
}

export interface CrmGatewayServers {
  /** The full catalog at `/mcp`, filtered per caller. */
  readonly catalog: McpHttpServerHandle;
  /** Semantic discovery at `/search/mcp`. */
  readonly discovery: McpHttpServerHandle;
  readonly catalogFingerprint: string;
  readonly indexed: number;
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
      index: options.index,
      ...(options.catalogPin === undefined
        ? {}
        : { catalogPin: options.catalogPin }),
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
      port: options.catalogPort ?? 3600,
      auth,
      visibility: built.gateway.visibility,
    });
    const discovery = await serveMcpHttp(built.discoveryEngine, {
      port: options.discoveryPort ?? 3602,
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
      indexed: built.indexed,
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

/** The index configured from the `EMBEDDINGS_*` variables. */
export function indexFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): SemanticToolIndex {
  const minSimilarity = environment.SEMANTIC_MIN_SIMILARITY;
  const dimensions = environment.EMBEDDINGS_DIMENSIONS;
  return createSemanticToolIndex({
    embedder: createOpenAiCompatibleEmbedder({
      baseUrl: environment.EMBEDDINGS_BASE_URL ?? "https://api.openai.com/v1",
      model: environment.EMBEDDINGS_MODEL ?? "text-embedding-3-small",
      ...(environment.EMBEDDINGS_API_KEY
        ? { apiKey: environment.EMBEDDINGS_API_KEY }
        : {}),
      ...(dimensions ? { dimensions: Number(dimensions) } : {}),
    }),
    ...(minSimilarity ? { minSimilarity: Number(minSimilarity) } : {}),
  });
}

async function main(): Promise<void> {
  const servers = await startCrmGateway({
    crmUrl: process.env.CRM_MCP_URL ?? "http://127.0.0.1:3401/mcp",
    crmServiceToken: required("CRM_SERVICE_TOKEN"),
    authenticate: apiKeyAuthenticator({
      keys: parseApiKeys(required("GATEWAY_API_KEYS")),
    }),
    index: indexFromEnvironment(process.env),
    ...(process.env.CRM_CATALOG_PIN === undefined
      ? {}
      : { catalogPin: process.env.CRM_CATALOG_PIN }),
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
      `indexed tools:     ${String(servers.indexed)}`,
      `full catalog:      http://${catalog.host}:${String(catalog.port)}/mcp`,
      `semantic search:   http://${discovery.host}:${String(discovery.port)}/search/mcp`,
      `catalog fingerprint: ${servers.catalogFingerprint}`,
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
