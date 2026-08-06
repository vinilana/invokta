import { randomUUID } from "node:crypto";

import { SignJWT } from "jose";

import { type AuthjsSession, sessionToPrincipal } from "./principal.js";

/**
 * Issues the short-lived access token this application hands to callers that
 * must reach the engine over MCP HTTP.
 *
 * This runs inside the host application, next to Auth.js, and never inside the
 * engine. The engine only verifies what this function signs.
 */

export type EngineAccessTokenSigningKey = Parameters<SignJWT["sign"]>[0];

export interface EngineAccessTokenIssuerOptions {
  readonly signingKey: EngineAccessTokenSigningKey;
  /** Key id published in this application's own JWKS document. */
  readonly keyId: string;
  readonly issuer: string;
  readonly audience: string;
  readonly algorithm?: string;
  readonly scopes?: ReadonlyArray<string>;
  /** Seconds until expiry. Must stay short-lived: 1 to 900 seconds. */
  readonly lifetimeSeconds?: number;
}

const defaultAlgorithm = "ES256";
const defaultScopes = ["engine:invoke"] as const;
const defaultLifetimeSeconds = 300;
const maximumLifetimeSeconds = 900;

/**
 * Returns the compact JWS, or `null` when the session proves no usable
 * identity. A caller without a session never receives a token.
 */
export async function issueEngineAccessToken(
  session: AuthjsSession | null | undefined,
  options: EngineAccessTokenIssuerOptions,
): Promise<string | null> {
  const lifetimeSeconds = options.lifetimeSeconds ?? defaultLifetimeSeconds;
  if (
    !Number.isInteger(lifetimeSeconds) ||
    lifetimeSeconds < 1 ||
    lifetimeSeconds > maximumLifetimeSeconds
  ) {
    throw new TypeError(
      `lifetimeSeconds must be an integer between 1 and ${maximumLifetimeSeconds}.`,
    );
  }

  const principal = sessionToPrincipal(session);
  if (principal === null) return null;

  const attributes = principal.attributes ?? {};
  const claims: Record<string, unknown> = {
    scope: [...(options.scopes ?? defaultScopes)].join(" "),
  };
  if (typeof attributes.email === "string") claims.email = attributes.email;
  if (typeof attributes.name === "string") claims.name = attributes.name;

  const issuedAt = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({
      alg: options.algorithm ?? defaultAlgorithm,
      kid: options.keyId,
      typ: "at+jwt",
    })
    .setIssuer(options.issuer)
    .setAudience(options.audience)
    .setSubject(principal.id)
    .setJti(randomUUID())
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + lifetimeSeconds)
    .sign(options.signingKey);
}
