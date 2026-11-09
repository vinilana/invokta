import { createEngine } from "@invokta/core";
import {
  createDiscovery,
  createGateway,
  type DiscoverySearchEvent,
  type GatewayDecision,
  type GatewayMcpConnection,
  mcpUpstream,
} from "@invokta/gateway";

import { crmRules } from "./access/rules.js";
import type {
  SemanticToolIndex,
  ToolDocument,
} from "./search/semantic-tool-index.js";

export const semanticGuidance =
  'Describe what the user wants to do in one sentence, in any language, for example "cancelar o pedido O-42". Matching tools come back with their input schemas.';

export interface CrmGatewayOptions {
  /** A connected MCP client for the vendor's CRM server. */
  readonly crm: GatewayMcpConnection;
  /** The embedding index that ranks tools for `search-tools`. */
  readonly index: SemanticToolIndex;
  readonly catalogPin?: string;
  /** Deadline for one query embedding before lexical search answers. */
  readonly searchTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly onDecision?: (decision: GatewayDecision) => void;
  readonly onSearch?: (event: DiscoverySearchEvent) => void;
}

/**
 * The vendor's 200-tool CRM behind the gateway, with semantic search.
 *
 * The composition root embeds every published tool once, before serving.
 * `search-tools` then embeds only the query and ranks the caller's visible
 * tools by cosine similarity. If the embeddings service fails or misses its
 * deadline, the gateway answers with its deterministic lexical search.
 */
export async function createCrmGateway(options: CrmGatewayOptions) {
  const crm = await mcpUpstream({
    name: "crm",
    connection: options.crm,
    trustAnnotations: true,
    ...(options.catalogPin === undefined ? {} : { pin: options.catalogPin }),
    timeoutMs: 10_000,
  });

  const gateway = createGateway({
    upstreams: [crm],
    rules: crmRules,
    ...(options.onDecision === undefined
      ? {}
      : { onDecision: options.onDecision }),
  });

  const discovery = createDiscovery({
    gateway,
    gatewayEngine: { name: "acme-crm-gateway", version: "0.1.0" },
    queryGuidance: semanticGuidance,
    rank: options.index.ranker,
    rankTimeoutMs: options.searchTimeoutMs ?? 5_000,
    ...(options.onSearch === undefined ? {} : { onSearch: options.onSearch }),
  });

  const documents: ToolDocument[] = gateway.routes.map((route) => {
    const described = discovery.gatewayEngine.describe(route.capabilityId);
    return {
      id: route.capabilityId,
      ...(described.title === undefined ? {} : { title: described.title }),
      description: described.description,
    };
  });
  const indexed = await options.index.prepare(documents, {
    signal: options.signal ?? AbortSignal.timeout(120_000),
  });

  return {
    gateway,
    discovery,
    indexed,
    catalogEngine: discovery.gatewayEngine,
    discoveryEngine: createEngine({
      name: "acme-crm-gateway-discovery",
      version: "0.1.0",
      capabilities: discovery.capabilities,
    }),
    catalogFingerprint: crm.fingerprint,
  };
}
