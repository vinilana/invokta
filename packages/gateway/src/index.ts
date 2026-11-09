export {
  type ApiKeyAuthenticatorOptions,
  type ApiKeyCredential,
  apiKeyAuthenticator,
  chainAuthenticators,
  type GatewayAuthenticationRequest,
  type GatewayAuthenticator,
  hashApiKey,
} from "./authentication.js";
export { requireScopes } from "./access.js";
export {
  createDiscovery,
  type Discovery,
  type DiscoveryCandidate,
  type DiscoveryOptions,
  type DiscoveryRanker,
  type DiscoverySearchEvent,
} from "./discovery.js";
export {
  type EngineUpstreamOptions,
  engineUpstream,
} from "./engine-upstream.js";
export { createGateway, type Gateway } from "./gateway.js";
export {
  createSearchIndex,
  type SearchDocument,
  type SearchIndex,
  tokenize,
} from "./search-index.js";
export {
  type GatewayMcpConnection,
  type GatewayMcpTool,
  type McpGatewayUpstream,
  type McpUpstreamOptions,
  mcpUpstream,
} from "./mcp-upstream.js";
export type {
  GatewayAccess,
  GatewayAccessArgs,
  GatewayAccessFunction,
  GatewayDecision,
  GatewayOptions,
  GatewayRoute,
  GatewayRule,
  GatewayUpstream,
  GatewayUpstreamKind,
  GatewayUpstreamRoute,
  GatewayVisibility,
} from "./types.js";
