import type { JwtBearerAuthenticator } from "@invokta/auth-jwt";
import type {
  AnyCapability,
  CapabilityMap,
  Engine,
  Principal,
} from "@invokta/core";
import type {
  HttpAuthenticationRequest,
  HttpAuthOptions,
  HttpCapabilityVisibility,
} from "@invokta/http";
import type {
  McpCapabilityVisibility,
  McpClientConnection,
  McpHttpAuthenticationRequest,
  McpHttpAuthOptions,
} from "@invokta/mcp";
import { expectTypeOf } from "vitest";

import {
  apiKeyAuthenticator,
  chainAuthenticators,
  createDiscovery,
  createGateway,
  createSearchIndex,
  type Discovery,
  type DiscoveryRanker,
  engineUpstream,
  type Gateway,
  type GatewayAccessFunction,
  type GatewayAuthenticationRequest,
  type GatewayAuthenticator,
  type GatewayDecision,
  type GatewayMcpConnection,
  type GatewayRule,
  type GatewayUpstream,
  type GatewayVisibility,
  hashApiKey,
  type JsonSchemaValidator,
  type McpCatalogLock,
  type McpCatalogLockError,
  type McpGatewayUpstream,
  type McpUpstreamOptions,
  mcpUpstream,
  requireScopes,
  type SearchIndex,
  tokenize,
} from "../src/index.js";

declare const engine: Engine;
declare const connection: McpClientConnection;
declare const validator: JsonSchemaValidator;
declare const jwt: JwtBearerAuthenticator;

// The visibility option is the adapters' option, in both directions.
expectTypeOf<GatewayVisibility>().toEqualTypeOf<McpCapabilityVisibility>();
expectTypeOf<GatewayVisibility>().toEqualTypeOf<HttpCapabilityVisibility>();

// The authentication request is the adapters' request, structurally.
expectTypeOf<HttpAuthenticationRequest>().toMatchTypeOf<GatewayAuthenticationRequest>();
expectTypeOf<McpHttpAuthenticationRequest>().toMatchTypeOf<GatewayAuthenticationRequest>();
expectTypeOf<GatewayAuthenticationRequest>().toMatchTypeOf<HttpAuthenticationRequest>();
expectTypeOf<GatewayAuthenticationRequest>().toMatchTypeOf<McpHttpAuthenticationRequest>();

// Gateway authenticators are the adapters' hooks as-is, and the JWT
// authenticator chains with them.
const authenticate = chainAuthenticators(
  jwt,
  apiKeyAuthenticator({ keys: [{ id: "bot", sha256: "0".repeat(64) }] }),
);
expectTypeOf(authenticate).toEqualTypeOf<GatewayAuthenticator>();
const mcpAuth: McpHttpAuthOptions = { mode: "required", authenticate };
const httpAuth: HttpAuthOptions = { mode: "required", authenticate };
expectTypeOf(mcpAuth).toMatchTypeOf<McpHttpAuthOptions>();
expectTypeOf(httpAuth).toMatchTypeOf<HttpAuthOptions>();
expectTypeOf(hashApiKey).returns.toEqualTypeOf<Promise<string>>();

// The MCP client connection of @invokta/mcp is a gateway connection.
expectTypeOf<McpClientConnection>().toMatchTypeOf<GatewayMcpConnection>();

const local = engineUpstream({ name: "billing", engine });
expectTypeOf(local).toEqualTypeOf<GatewayUpstream>();
engineUpstream({ name: "billing", engine, validator });

const remote = mcpUpstream({ name: "docs", connection, validator });
expectTypeOf(remote).toEqualTypeOf<Promise<McpGatewayUpstream>>();
mcpUpstream({ name: "docs", connection, validator: "delegate-to-upstream" });
expectTypeOf<McpGatewayUpstream["lock"]>().toEqualTypeOf<McpCatalogLock>();
expectTypeOf<McpCatalogLockError>().toMatchTypeOf<Error>();

// @ts-expect-error Every MCP upstream chooses how input is validated.
mcpUpstream({ name: "docs", connection });

mcpUpstream({
  name: "docs",
  connection,
  // @ts-expect-error The only delegation value is "delegate-to-upstream".
  validator: "none",
});

const asyncValidator = async () => [];
mcpUpstream({
  name: "docs",
  connection,
  // @ts-expect-error A validator is synchronous, so it cannot outlive a timeout.
  validator: asyncValidator,
});

const options = {
  name: "docs",
  connection,
  validator,
  forwardToolErrors: false,
  discoveryTimeoutMs: 30_000,
  maxToolBytes: 65_536,
} satisfies McpUpstreamOptions;
expectTypeOf(options).toMatchTypeOf<McpUpstreamOptions>();

// Access functions see the principal, input, context, and route.
const scoped: GatewayAccessFunction = requireScopes("billing:read");
const rules: GatewayRule[] = [
  { name: "billing", match: "billing.*", access: scoped },
  {
    match: ["docs.search", "docs.read"],
    access: ({ principal, route }) => principal !== null && route.readOnly,
    visible: (principal) => principal !== null,
  },
];

const gateway = createGateway({
  upstreams: [local],
  rules,
  defaultAccess: "deny",
  onDecision: (decision) => {
    expectTypeOf(decision).toEqualTypeOf<GatewayDecision>();
  },
});
expectTypeOf(gateway).toEqualTypeOf<Gateway>();
expectTypeOf(gateway.capabilities).toEqualTypeOf<CapabilityMap>();
expectTypeOf(gateway.visibility).toEqualTypeOf<GatewayVisibility>();

createGateway({
  upstreams: [local],
  // @ts-expect-error Rule visibility is synchronous and never sees input.
  rules: [{ match: "*", access: "public", visible: async () => true }],
});

// @ts-expect-error There is no allow-all access keyword.
createGateway({ upstreams: [local], defaultAccess: "allow" });

const ranker: DiscoveryRanker = async (_query, candidates, { signal }) => {
  expectTypeOf(signal).toEqualTypeOf<AbortSignal>();
  return candidates.map((candidate) => candidate.id);
};
const discovery = createDiscovery({
  gateway,
  alwaysList: ["billing.*"],
  rank: ranker,
  rankTimeoutMs: 2_000,
  gatewayEngine: { name: "gateway", version: "1.0.0", middleware: [] },
});
expectTypeOf(discovery).toEqualTypeOf<Discovery>();
expectTypeOf(discovery.gatewayEngine).toEqualTypeOf<Engine>();
expectTypeOf(discovery.capabilities).toEqualTypeOf<CapabilityMap>();
expectTypeOf<
  Discovery["capabilities"][string]
>().toEqualTypeOf<AnyCapability>();

const index = createSearchIndex([{ id: "billing.get", description: "Get" }]);
expectTypeOf(index).toEqualTypeOf<SearchIndex>();
expectTypeOf(tokenize).returns.toEqualTypeOf<string[]>();

// Visibility receives exactly the adapters' arguments.
expectTypeOf<Parameters<GatewayVisibility>[0]>().toEqualTypeOf<{
  readonly principal: Principal | null;
  readonly capabilityId: string;
}>();
