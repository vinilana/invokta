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
import type { JevToolSelector } from "./selection/jev-tool-selector.js";

export const taskGuidance =
  'Describe the user\'s whole task in one sentence, in any language, for example "cancel order O-42 and archive its invoice". The gateway returns only the tools the task needs; an empty list means none is needed or the task is unclear.';

export interface CrmGatewayOptions {
  /** A connected MCP client for the vendor's CRM server. */
  readonly crm: GatewayMcpConnection;
  /** Jev decides which of the caller's visible tools the task needs. */
  readonly selector: JevToolSelector;
  readonly catalogPin?: string;
  /** Deadline for one Jev selection before lexical search answers. */
  readonly selectionTimeoutMs?: number;
  readonly onDecision?: (decision: GatewayDecision) => void;
  readonly onSearch?: (event: DiscoverySearchEvent) => void;
}

/**
 * The vendor's 200-tool CRM behind the gateway, with Jev selecting tools.
 *
 * Jev sits in the `rank` port of the gateway's discovery: `search-tools`
 * receives the task, Jev judges only the tools the caller may see, and the
 * result contains the tools it needs. Invocation still goes through the
 * target's gateway rule, and if Jev fails or misses its deadline the
 * gateway answers with its deterministic lexical search instead.
 */
export async function createCrmGateway(options: CrmGatewayOptions) {
  const crm = await mcpUpstream({
    validator: "delegate-to-upstream",
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
    queryGuidance: taskGuidance,
    rank: options.selector.ranker,
    rankTimeoutMs: options.selectionTimeoutMs ?? 15_000,
    ...(options.onSearch === undefined ? {} : { onSearch: options.onSearch }),
  });

  return {
    gateway,
    discovery,
    catalogEngine: discovery.gatewayEngine,
    discoveryEngine: createEngine({
      name: "acme-crm-gateway-discovery",
      version: "0.1.0",
      capabilities: discovery.capabilities,
    }),
    catalogFingerprint: crm.fingerprint,
  };
}
