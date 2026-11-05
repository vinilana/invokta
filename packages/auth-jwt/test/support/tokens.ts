import {
  exportJWK,
  generateKeyPair,
  type JSONWebKeySet,
  type JWK,
  type JWTPayload,
  SignJWT,
} from "jose";

/**
 * Offline token factory. Every key is generated in the test process and every
 * token is signed locally, so signature verification is real and no test
 * reaches an identity provider.
 */

export const testIssuer = "https://identity.example.com";
export const testAudience = "https://engine.example.com/mcp";
export const rsaKeyId = "test-rsa-key";
export const ellipticKeyId = "test-ec-key";

export interface TestKeys {
  /** Public keys published by the test issuer. */
  readonly jwks: JSONWebKeySet;
  readonly rsaPrivateKey: CryptoKey;
  readonly ellipticPrivateKey: CryptoKey;
  /** A key whose public half is never published. */
  readonly foreignPrivateKey: CryptoKey;
}

export interface MintOptions {
  readonly algorithm?: string;
  readonly keyId?: string | null;
  readonly key?: CryptoKey | Uint8Array;
  /** Seconds since the epoch; `null` omits the claim. */
  readonly expiresAt?: number | null;
  readonly notBefore?: number;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export async function createTestKeys(): Promise<TestKeys> {
  const rsa = await generateKeyPair("RS256", { extractable: true });
  const elliptic = await generateKeyPair("ES256", { extractable: true });
  const foreign = await generateKeyPair("RS256", { extractable: true });

  const rsaJwk: JWK = {
    ...(await exportJWK(rsa.publicKey)),
    kid: rsaKeyId,
    alg: "RS256",
    use: "sig",
  };
  const ellipticJwk: JWK = {
    ...(await exportJWK(elliptic.publicKey)),
    kid: ellipticKeyId,
    alg: "ES256",
    use: "sig",
  };

  return {
    jwks: { keys: [rsaJwk, ellipticJwk] },
    rsaPrivateKey: rsa.privateKey,
    ellipticPrivateKey: elliptic.privateKey,
    foreignPrivateKey: foreign.privateKey,
  };
}

export function validClaims(overrides: JWTPayload = {}): JWTPayload {
  return {
    iss: testIssuer,
    aud: testAudience,
    sub: "user-42",
    scope: "engine:invoke reports:read",
    client_id: "reporting-cli",
    ...overrides,
  };
}

export async function mintToken(
  keys: TestKeys,
  claims: JWTPayload = validClaims(),
  options: MintOptions = {},
): Promise<string> {
  const algorithm = options.algorithm ?? "RS256";
  const keyId =
    options.keyId === undefined
      ? algorithm === "ES256"
        ? ellipticKeyId
        : rsaKeyId
      : options.keyId;
  const issuedAt = nowSeconds();
  const jwt = new SignJWT(claims)
    .setProtectedHeader({
      alg: algorithm,
      typ: "at+jwt",
      ...(keyId === null ? {} : { kid: keyId }),
    })
    .setIssuedAt(issuedAt);
  if (options.expiresAt !== null) {
    jwt.setExpirationTime(options.expiresAt ?? issuedAt + 300);
  }
  if (options.notBefore !== undefined) jwt.setNotBefore(options.notBefore);

  const key =
    options.key ??
    (algorithm === "ES256" ? keys.ellipticPrivateKey : keys.rsaPrivateKey);
  return jwt.sign(key);
}

/** The structural request view the authenticator accepts. */
export function bearerRequest(
  authorization: string | undefined,
  signal?: AbortSignal,
) {
  return {
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "authorization" ? (authorization ?? null) : null,
    },
    ...(signal === undefined ? {} : { signal }),
  };
}
