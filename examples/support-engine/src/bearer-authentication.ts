import type { Principal } from "@invokta/core";

import { localPrincipal } from "./local-principal.js";

/**
 * The part of an HTTP authentication request this demonstration reads. Both
 * `McpHttpAuthenticationRequest` and `HttpAuthenticationRequest` satisfy it,
 * so one authenticator serves the MCP HTTP and plain HTTP entrypoints.
 */
export interface BearerAuthenticationRequest {
  readonly headers: { readonly get: (name: string) => string | null };
}

/**
 * A deterministic literal-token check for local demonstration only. A real
 * deployment replaces it with its identity provider's verifier.
 */
export function createDevelopmentBearerAuthenticator(
  expectedBearerToken: string,
): (request: BearerAuthenticationRequest) => Principal | null {
  return (request) =>
    request.headers.get("authorization") === `Bearer ${expectedBearerToken}`
      ? localPrincipal
      : null;
}
