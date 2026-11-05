import type { Principal } from "@invokta/core";
import type { McpHttpAuthOptions } from "@invokta/mcp";
import { expectTypeOf } from "vitest";

import {
  createJwtBearerAuthenticator,
  defaultJwtPrincipal,
  isJwtSignatureAlgorithm,
  type JwtBearerAuthenticator,
  type JwtBearerAuthenticatorOptions,
  type JwtBearerRequest,
  type JwtKeySource,
  type JwtPrincipal,
  type JwtPrincipalMapper,
  type JwtSignatureAlgorithm,
  JwtVerificationUnavailableError,
  type VerifiedJwtClaims,
} from "../src/index.js";

declare const jwks: { keys: [] };

const authenticate = createJwtBearerAuthenticator({
  issuer: "https://identity.example.com",
  audience: "https://engine.example.com/mcp",
  algorithms: ["RS256"],
  jwksUrl: "https://identity.example.com/.well-known/jwks.json",
});
expectTypeOf(authenticate).toEqualTypeOf<JwtBearerAuthenticator>();
expectTypeOf(authenticate).returns.toEqualTypeOf<
  Promise<JwtPrincipal | null>
>();

// The authenticator is the MCP HTTP hook as-is.
const auth: McpHttpAuthOptions = { mode: "required", authenticate };
expectTypeOf(auth).toMatchTypeOf<McpHttpAuthOptions>();

// Its principal is the core Principal, structurally.
expectTypeOf<JwtPrincipal>().toMatchTypeOf<Principal>();
expectTypeOf<Principal>().toMatchTypeOf<JwtPrincipal>();

// A Web Request fits the structural request view, as does a bare header view.
expectTypeOf<Request>().toMatchTypeOf<JwtBearerRequest>();
expectTypeOf<{
  headers: { get(name: string): string | null };
}>().toMatchTypeOf<JwtBearerRequest>();

// A local key set is the offline alternative to a remote JWKS URL.
const local: JwtBearerAuthenticatorOptions = {
  issuer: "https://identity.example.com",
  audience: ["https://engine.example.com/mcp"],
  algorithms: ["ES256", "EdDSA"],
  jwks,
  clockToleranceSeconds: 5,
  requiredScopes: ["engine:invoke"],
  maxTokenLength: 4096,
  principal: (claims) => ({ id: String(claims.sub) }),
};
expectTypeOf(local).toMatchTypeOf<JwtKeySource>();

const mapper: JwtPrincipalMapper = defaultJwtPrincipal;
expectTypeOf(mapper).parameter(0).toEqualTypeOf<VerifiedJwtClaims>();

declare const candidate: string;
if (isJwtSignatureAlgorithm(candidate)) {
  expectTypeOf(candidate).toEqualTypeOf<JwtSignatureAlgorithm>();
}

expectTypeOf(new JwtVerificationUnavailableError()).toMatchTypeOf<Error>();

// @ts-expect-error A key source is either a remote URL or a local set.
createJwtBearerAuthenticator({
  issuer: "https://identity.example.com",
  audience: "https://engine.example.com/mcp",
  algorithms: ["RS256"],
  jwksUrl: "https://identity.example.com/jwks",
  jwks,
});

createJwtBearerAuthenticator({
  issuer: "https://identity.example.com",
  audience: "https://engine.example.com/mcp",
  // @ts-expect-error Unsecured and shared-secret algorithms are not accepted.
  algorithms: ["none"],
  jwks,
});

// @ts-expect-error The algorithm allowlist is required.
createJwtBearerAuthenticator({
  issuer: "https://identity.example.com",
  audience: "https://engine.example.com/mcp",
  jwks,
});

createJwtBearerAuthenticator({
  issuer: "https://identity.example.com",
  audience: "https://engine.example.com/mcp",
  algorithms: ["RS256"],
  jwks,
  // @ts-expect-error The mapper receives claims, never the raw token.
  principal: (_claims: VerifiedJwtClaims, token: string) => ({ id: token }),
});
