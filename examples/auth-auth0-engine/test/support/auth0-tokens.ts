import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import {
  exportJWK,
  generateKeyPair,
  type JSONWebKeySet,
  type JWTPayload,
  SignJWT,
} from "jose";

/**
 * Offline Auth0 token factory.
 *
 * Every test signs its own RS256 tokens with a locally generated key pair and
 * publishes the public half as a local JWKS, so signature verification is real
 * and no test ever reaches an Auth0 tenant.
 */

export const testDomain = "tenant.eu.auth0.example";
export const testIssuer = `https://${testDomain}/`;
export const testAudience = "https://orders.example.com/api";

export interface Auth0TokenFactory {
  /** The tenant's published signing keys, injected as a local key set. */
  readonly jwks: JSONWebKeySet;
  sign(claims: JWTPayload, options?: SignOptions): Promise<string>;
  /** Signs with a key that is absent from the published JWKS. */
  signWithForeignKey(claims: JWTPayload): Promise<string>;
}

export interface SignOptions {
  readonly issuedAt?: number;
  /** `null` mints a token without an `exp` claim. */
  readonly expiresAt?: number | null;
  readonly keyId?: string;
}

const publishedKeyId = "published-test-key";
const foreignKeyId = "foreign-test-key";

export async function createAuth0TokenFactory(): Promise<Auth0TokenFactory> {
  const published = await generateKeyPair("RS256", { extractable: true });
  const foreign = await generateKeyPair("RS256", { extractable: true });
  const publishedJwk = await exportJWK(published.publicKey);
  const jwks: JSONWebKeySet = {
    keys: [{ ...publishedJwk, alg: "RS256", use: "sig", kid: publishedKeyId }],
  };

  const now = () => Math.floor(Date.now() / 1000);

  return {
    jwks,
    async sign(claims, options = {}) {
      const issuedAt = options.issuedAt ?? now();
      const jwt = new SignJWT(claims)
        .setProtectedHeader({
          alg: "RS256",
          kid: options.keyId ?? publishedKeyId,
        })
        .setIssuedAt(issuedAt);
      if (options.expiresAt !== null) {
        jwt.setExpirationTime(options.expiresAt ?? issuedAt + 3600);
      }
      return jwt.sign(published.privateKey);
    },
    async signWithForeignKey(claims) {
      const issuedAt = now();
      return new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: publishedKeyId })
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + 3600)
        .sign(foreign.privateKey);
    },
  };
}

export function validClaims(overrides: JWTPayload = {}): JWTPayload {
  return {
    iss: testIssuer,
    aud: testAudience,
    sub: "auth0|64f0c0ffee0000000000abcd",
    azp: "0oaTestClientIdentifier",
    scope: "openid profile orders:read orders:write",
    ...overrides,
  };
}

export interface JwksOutage {
  /** A loopback key-set URL that always answers HTTP 503. */
  readonly url: URL;
  close(): Promise<void>;
}

/**
 * Stands in for an unreachable tenant: a loopback JWKS endpoint that refuses
 * every request, so the remote key-set path fails over real HTTP.
 */
export async function startJwksOutage(): Promise<JwksOutage> {
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(503, { "content-type": "text/plain" });
    response.end("JWKS endpoint refused.");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: new URL(`http://127.0.0.1:${port}/.well-known/jwks.json`),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export { foreignKeyId, publishedKeyId };
