import { createEngine } from "@invokta/core";
import {
  createDiscovery,
  createGateway,
  type DiscoveryRanker,
  type DiscoverySearchEvent,
  type GatewayDecision,
  type GatewayMcpConnection,
  mcpUpstream,
} from "@invokta/gateway";

import { crmRules } from "./access/rules.js";

export interface CrmGatewayOptions {
  /** A connected MCP client for the vendor's CRM server. */
  readonly crm: GatewayMcpConnection;
  /** Fingerprint of the reviewed catalog; startup fails on any change. */
  readonly catalogPin?: string;
  /** Optional host ranker, for example `portugueseGlossaryRanker`. */
  readonly rank?: DiscoveryRanker;
  readonly onDecision?: (decision: GatewayDecision) => void;
  readonly onSearch?: (event: DiscoverySearchEvent) => void;
}

/**
 * The composition root for a 200-tool vendor CRM. It returns two engines:
 *
 * - `catalogEngine`, the full catalog, for clients that search tools on
 *   their own (serve it with `gateway.visibility`); and
 * - `discoveryEngine`, three discovery tools plus a short `alwaysList`, for
 *   clients that should not receive hundreds of tools (serve it with
 *   `discovery.visibility`).
 *
 * Both reach the vendor through the same gateway engine and rules.
 */
export async function createCrmGateway(options: CrmGatewayOptions) {
  const crm = await mcpUpstream({
    validator: "delegate-to-upstream",
    name: "crm",
    connection: options.crm,
    // The team reviewed the vendor's annotations and pins the catalog, so a
    // changed tool or hint fails startup until it is reviewed again.
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
    alwaysList: ["crm.service_search-ticket", "crm.accounts_get-customer"],
    ...(options.rank === undefined ? {} : { rank: options.rank }),
    ...(options.onSearch === undefined ? {} : { onSearch: options.onSearch }),
  });

  const discoveryEngine = createEngine({
    name: "acme-crm-gateway-discovery",
    version: "0.1.0",
    capabilities: discovery.capabilities,
  });

  return {
    gateway,
    discovery,
    catalogEngine: discovery.gatewayEngine,
    discoveryEngine,
    catalogFingerprint: crm.fingerprint,
  };
}
