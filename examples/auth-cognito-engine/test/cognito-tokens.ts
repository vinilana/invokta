import {
  exportJWK,
  generateKeyPair,
  type JSONWebKeySet,
  type JWTPayload,
  SignJWT,
} from "jose";

/**
 * Offline test fixtures that mint tokens in the Amazon Cognito user pool
 * access-token claim shape. No network call and no real user pool is involved:
 * the key pair is generated locally and served through a local JWKS.
 */

export const region = "us-east-1";
export const userPoolId = "us-east-1_ExamplePool";
export const issuer = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
export const appClientId = "1example23456789";
export const subject = "8b7e0c1e-4f2a-4c39-9b4f-2a1d6f5c0e11";

export interface CognitoTokenFactory {
  readonly jwks: JSONWebKeySet;
  sign(claims: JWTPayload): Promise<string>;
}

export async function createTokenFactory(
  keyId = "cognito-test-key",
): Promise<CognitoTokenFactory> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  const jwks: JSONWebKeySet = {
    keys: [{ ...publicJwk, kid: keyId, alg: "RS256", use: "sig" }],
  };

  return {
    jwks,
    async sign(claims) {
      return new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: keyId })
        .sign(privateKey);
    },
  };
}

/**
 * The documented Amazon Cognito access-token payload: `sub`, `token_use`,
 * `scope`, `cognito:groups`, `client_id`, `username`, `iss`, `exp`, `iat`,
 * `auth_time`, and `jti`. An access token carries no `aud` claim on purpose.
 */
export function accessTokenClaims(overrides: JWTPayload = {}): JWTPayload {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: subject,
    iss: issuer,
    client_id: appClientId,
    token_use: "access",
    scope: "engine/invoke openid",
    "cognito:groups": ["support-engineers"],
    username: "ada",
    auth_time: now,
    iat: now,
    exp: now + 3_600,
    jti: "4d1f9b4e-9d1a-4f0a-8f2f-1f1b9d3c7a10",
    ...overrides,
  };
}
