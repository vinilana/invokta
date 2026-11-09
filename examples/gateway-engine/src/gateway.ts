import { createEngine } from "@invokta/core";
import {
  createGateway,
  engineUpstream,
  type GatewayDecision,
  type GatewayMcpConnection,
  mcpUpstream,
} from "@invokta/gateway";

import { acmeRules } from "./access/rules.js";
import { createBillingEngine } from "./upstreams/billing-engine.js";
import { createSupportEngine } from "./upstreams/support-engine.js";

export interface AcmeGatewayOptions {
  /** A connected MCP client for the documentation team's server. */
  readonly docs: GatewayMcpConnection;
  /** Expected fingerprint of the docs catalog; startup fails on any change. */
  readonly docsCatalogPin?: string;
  readonly onDecision?: (decision: GatewayDecision) => void;
}

/**
 * The composition root of Acme's gateway: two in-process Action Engines and
 * one remote MCP server, published as one engine under one policy.
 */
export async function createAcmeGateway(options: AcmeGatewayOptions) {
  const docs = await mcpUpstream({
    name: "docs",
    namespace: "kb",
    connection: options.docs,
    // The gateway operator reviewed this tool; the server's own hint alone
    // would not be trusted.
    readOnlyTools: ["docs_search"],
    timeoutMs: 10_000,
    ...(options.docsCatalogPin === undefined
      ? {}
      : { pin: options.docsCatalogPin }),
  });

  const gateway = createGateway({
    upstreams: [
      engineUpstream({ name: "support", engine: createSupportEngine() }),
      engineUpstream({ name: "billing", engine: createBillingEngine() }),
      docs,
    ],
    rules: acmeRules,
    ...(options.onDecision === undefined
      ? {}
      : { onDecision: options.onDecision }),
  });

  const engine = createEngine({
    name: "acme-gateway",
    version: "0.1.0",
    capabilities: gateway.capabilities,
  });

  return { gateway, engine, docsFingerprint: docs.fingerprint };
}
