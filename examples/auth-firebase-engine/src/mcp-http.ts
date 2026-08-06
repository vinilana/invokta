/**
 * MCP HTTP composition root for Firebase Auth ID tokens.
 *
 * The hook has exactly three outcomes, in the order the adapter expects them:
 * a principal for a verified token, `null` for any invalid or missing
 * credential, and a rejection only when verification could not complete.
 */
import type { Principal } from "@invokta/core";
import {
  type McpHttpAuthenticationRequest,
  type McpHttpAuthOptions,
  type McpHttpHeaderView,
  type McpHttpServerHandle,
  serveMcpHttp,
} from "@invokta/mcp";

import { engine } from "./engine.js";
import {
  type FirebasePrincipalOptions,
  toPrincipal,
} from "./identity/principal.js";
import type { FirebaseIdTokenVerifier } from "./identity/verifier.js";

export interface FirebaseAuthenticationOptions
  extends FirebasePrincipalOptions {
  readonly verifier: FirebaseIdTokenVerifier;
}

/** A Firebase ID token is a compact JWS, so a token that cannot be one is
 * rejected before any provider call. */
const COMPACT_JWS = /^[\w-]+\.[\w-]+\.[\w-]+$/u;
const BEARER_CREDENTIAL = /^Bearer ([^\s]+)$/u;
/** Firebase ID tokens are far below this bound; it caps verification work. */
const MAX_ID_TOKEN_LENGTH = 4_096;

function readBearerToken(headers: McpHttpHeaderView): string | null {
  const authorization = headers.get("authorization");
  if (authorization === null) return null;
  return BEARER_CREDENTIAL.exec(authorization)?.[1] ?? null;
}

export function createFirebaseAuthenticate(
  options: FirebaseAuthenticationOptions,
): (request: McpHttpAuthenticationRequest) => Promise<Principal | null> {
  const { verifier, ...principalOptions } = options;

  return async (request) => {
    const idToken = readBearerToken(request.headers);
    if (
      idToken === null ||
      idToken.length > MAX_ID_TOKEN_LENGTH ||
      !COMPACT_JWS.test(idToken)
    ) {
      return null;
    }

    // A rejection here is deliberately not caught: only the verifier can tell
    // an invalid credential (null) from an unavailable check (throw).
    const claims = await verifier.verifyIdToken(idToken, {
      signal: request.signal,
    });
    return claims === null ? null : toPrincipal(claims, principalOptions);
  };
}

export function createFirebaseHttpAuth(
  options: FirebaseAuthenticationOptions,
): McpHttpAuthOptions {
  return {
    mode: "required",
    authenticate: createFirebaseAuthenticate(options),
  };
}

export interface FirebaseMcpHttpOptions extends FirebaseAuthenticationOptions {
  readonly host?: string;
  readonly port?: number;
}

/**
 * Serves the engine over MCP Streamable HTTP with Firebase authentication.
 *
 * The verifier is injected: this example ships no `firebase-admin` dependency,
 * so a host wires `createAdminIdTokenVerifier(getAuth())` — or any other
 * implementation of the port — from its own composition root.
 */
export async function startFirebaseMcpHttp(
  options: FirebaseMcpHttpOptions,
): Promise<McpHttpServerHandle> {
  const { host, port, ...authenticationOptions } = options;

  return serveMcpHttp(engine, {
    ...(host === undefined ? {} : { host }),
    ...(port === undefined ? {} : { port }),
    auth: createFirebaseHttpAuth(authenticationOptions),
  });
}
