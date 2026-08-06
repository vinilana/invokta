import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTVerifyGetKey,
  SignJWT,
} from "jose";

/**
 * Offline Supabase-shaped token minting.
 *
 * Nothing here touches the network: a local key pair stands in for the project
 * signing key and `createLocalJWKSet` stands in for the project's
 * `<issuer>/.well-known/jwks.json` document.
 */

export const projectUrl = "https://abcdefghijklmnopqrst.supabase.co";
export const issuer = `${projectUrl}/auth/v1`;
export const subject = "3b2a1c00-0000-4000-8000-000000000001";
export const sessionId = "5f9d0000-0000-4000-8000-0000000000ab";
export const keyId = "test-only-signing-key";

export interface SupabaseTokenOptions {
  readonly issuer?: string;
  readonly audience?: string;
  readonly subject?: string | null;
  /** `null` mints a token without an `exp` claim. */
  readonly expiresAt?: string | number | null;
  readonly keyId?: string;
  readonly signWith?: "project" | "attacker";
}

export interface SupabaseTokenFactory {
  /** Stands in for `createRemoteJWKSet(new URL(jwksUrl))` in production. */
  readonly keys: JWTVerifyGetKey;
  readonly sign: (
    claims?: Readonly<Record<string, unknown>>,
    options?: SupabaseTokenOptions,
  ) => Promise<string>;
}

export async function createTokenFactory(): Promise<SupabaseTokenFactory> {
  const project = await generateKeyPair("ES256", { extractable: true });
  const attacker = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = await exportJWK(project.publicKey);
  const keys = createLocalJWKSet({
    keys: [{ ...publicJwk, alg: "ES256", kid: keyId, use: "sig" }],
  });

  return {
    keys,
    async sign(claims = {}, options = {}) {
      const privateKey =
        options.signWith === "attacker"
          ? attacker.privateKey
          : project.privateKey;
      const token = new SignJWT({
        role: "authenticated",
        email: "ada@example.com",
        session_id: sessionId,
        is_anonymous: false,
        ...claims,
      })
        .setProtectedHeader({ alg: "ES256", kid: options.keyId ?? keyId })
        .setIssuer(options.issuer ?? issuer)
        .setAudience(options.audience ?? "authenticated")
        .setIssuedAt();
      if (options.expiresAt !== null) {
        token.setExpirationTime(options.expiresAt ?? "1h");
      }
      if (options.subject !== null) {
        token.setSubject(options.subject ?? subject);
      }
      return token.sign(privateKey);
    },
  };
}
