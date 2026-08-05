import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTPayload,
  type JWTVerifyGetKey,
  SignJWT,
} from "jose";

/**
 * Offline Auth0 token factory.
 *
 * Every test signs its own RS256 tokens with a locally generated key pair and
 * resolves them through `createLocalJWKSet`, so signature verification is real
 * and no test ever reaches an Auth0 tenant.
 */

export const testDomain = "tenant.eu.auth0.example";
export const testIssuer = `https://${testDomain}/`;
export const testAudience = "https://orders.example.com/api";

export interface Auth0TokenFactory {
  /** Key resolution injected into the verifier under test. */
  readonly keySource: JWTVerifyGetKey;
  /** A key source that always fails, standing in for a JWKS outage. */
  readonly failingKeySource: JWTVerifyGetKey;
  sign(claims: JWTPayload, options?: SignOptions): Promise<string>;
  /** Signs with a key that is absent from the published JWKS. */
  signWithForeignKey(claims: JWTPayload): Promise<string>;
}

export interface SignOptions {
  readonly issuedAt?: number;
  readonly expiresAt?: number;
  readonly keyId?: string;
}

const publishedKeyId = "published-test-key";
const foreignKeyId = "foreign-test-key";

export async function createAuth0TokenFactory(): Promise<Auth0TokenFactory> {
  const published = await generateKeyPair("RS256", { extractable: true });
  const foreign = await generateKeyPair("RS256", { extractable: true });
  const publishedJwk = await exportJWK(published.publicKey);
  const keySource = createLocalJWKSet({
    keys: [{ ...publishedJwk, alg: "RS256", use: "sig", kid: publishedKeyId }],
  });

  const now = () => Math.floor(Date.now() / 1000);

  return {
    keySource,
    failingKeySource: () => Promise.reject(new Error("JWKS endpoint refused.")),
    async sign(claims, options = {}) {
      const issuedAt = options.issuedAt ?? now();
      return new SignJWT(claims)
        .setProtectedHeader({
          alg: "RS256",
          kid: options.keyId ?? publishedKeyId,
        })
        .setIssuedAt(issuedAt)
        .setExpirationTime(options.expiresAt ?? issuedAt + 3600)
        .sign(published.privateKey);
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

export { foreignKeyId, publishedKeyId };
