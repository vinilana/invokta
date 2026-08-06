import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JSONWebKeySet,
  SignJWT,
} from "jose";

import type { AuthjsSession } from "../../src/identity/principal.js";

/**
 * Offline key material and token factories for this example's tests.
 *
 * Every key pair is generated in-process and the JSON Web Key Set is resolved
 * with `createLocalJWKSet`, so signature verification is real while the tests
 * perform no network I/O and use no provider account.
 */

export const testIssuer = "https://app.example.test";
export const testAudience = "https://engine.example.test/mcp";
export const testAlgorithm = "ES256";
export const testKeyId = "authjs-engine-test-key";

export async function createTestKeyMaterial() {
  const primary = await generateKeyPair(testAlgorithm, { extractable: true });
  const foreign = await generateKeyPair(testAlgorithm, { extractable: true });
  const publicJwk = await exportJWK(primary.publicKey);
  const jwks: JSONWebKeySet = {
    keys: [{ ...publicJwk, kid: testKeyId, alg: testAlgorithm, use: "sig" }],
  };

  return {
    jwks,
    resolveKey: createLocalJWKSet(jwks),
    signingKey: primary.privateKey,
    foreignSigningKey: foreign.privateKey,
  };
}

export interface TestTokenOverrides {
  readonly issuer?: string;
  readonly audience?: string;
  readonly subject?: string | null;
  readonly keyId?: string;
  readonly issuedAt?: number;
  readonly expiresAt?: number;
  readonly scope?: string;
  readonly email?: string;
  readonly name?: string;
}

/** Mints an app-issued engine access token with arbitrary overrides. */
export async function signTestToken(
  signingKey: Awaited<ReturnType<typeof createTestKeyMaterial>>["signingKey"],
  overrides: TestTokenOverrides = {},
): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {
    scope: overrides.scope ?? "engine:invoke",
  };
  if (overrides.email !== undefined) claims.email = overrides.email;
  if (overrides.name !== undefined) claims.name = overrides.name;

  const token = new SignJWT(claims)
    .setProtectedHeader({
      alg: testAlgorithm,
      kid: overrides.keyId ?? testKeyId,
      typ: "at+jwt",
    })
    .setIssuer(overrides.issuer ?? testIssuer)
    .setAudience(overrides.audience ?? testAudience)
    .setIssuedAt(overrides.issuedAt ?? nowSeconds)
    .setExpirationTime(overrides.expiresAt ?? nowSeconds + 300);

  const subject =
    overrides.subject === undefined ? "user_2f1a" : overrides.subject;
  if (subject !== null) token.setSubject(subject);

  return token.sign(signingKey);
}

export function createTestSession(
  overrides: Partial<AuthjsSession> = {},
): AuthjsSession {
  return {
    expires: new Date(Date.now() + 3_600_000).toISOString(),
    user: {
      id: "user_2f1a",
      name: "Ada Lovelace",
      email: "ada@example.test",
      image: "https://cdn.example.test/avatars/ada.png",
    },
    ...overrides,
  };
}
