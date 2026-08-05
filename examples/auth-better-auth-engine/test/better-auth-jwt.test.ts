import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTVerifyGetKey,
  SignJWT,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import {
  type BetterAuthTokenVerifier,
  betterAuthJwksUrl,
  createBetterAuthJwtVerifier,
  IdentityVerificationUnavailableError,
} from "../src/identity/verifier.js";

const issuer = "https://app.example.com";
const audience = "https://app.example.com";
const keyId = "better-auth-test-key";

interface TokenClaims {
  readonly [claim: string]: unknown;
}

let signingKey: CryptoKey;
let keys: JWTVerifyGetKey;
let otherSigningKey: CryptoKey;
let verifier: BetterAuthTokenVerifier;

async function signToken(
  claims: TokenClaims,
  overrides: {
    readonly issuer?: string;
    readonly audience?: string;
    readonly expiration?: string | number;
    readonly key?: CryptoKey;
    readonly subject?: string | null;
  } = {},
): Promise<string> {
  const builder = new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", kid: keyId })
    .setIssuedAt()
    .setIssuer(overrides.issuer ?? issuer)
    .setAudience(overrides.audience ?? audience)
    .setExpirationTime(overrides.expiration ?? "15m");
  const subject =
    overrides.subject === undefined ? "user_01" : overrides.subject;
  if (subject !== null) builder.setSubject(subject);
  return builder.sign(overrides.key ?? signingKey);
}

function activeSignal(): AbortSignal {
  return new AbortController().signal;
}

beforeAll(async () => {
  const pair = await generateKeyPair("EdDSA", {
    crv: "Ed25519",
    extractable: true,
  });
  const otherPair = await generateKeyPair("EdDSA", {
    crv: "Ed25519",
    extractable: true,
  });
  signingKey = pair.privateKey;
  otherSigningKey = otherPair.privateKey;
  keys = createLocalJWKSet({
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: keyId, alg: "EdDSA" }],
  });
  verifier = createBetterAuthJwtVerifier({ issuer, audience, keys });
});

describe("the Better Auth JWKS URL", () => {
  it("derives the plugin's default JWKS path from the app base URL", () => {
    expect(betterAuthJwksUrl("https://app.example.com").href).toBe(
      "https://app.example.com/api/auth/jwks",
    );
    expect(betterAuthJwksUrl("https://app.example.com/").href).toBe(
      "https://app.example.com/api/auth/jwks",
    );
  });
});

describe("the Better Auth JWT verifier", () => {
  it("accepts a token signed by the app's JWKS key", async () => {
    const token = await signToken({
      email: "ada@example.com",
      emailVerified: true,
      name: "Ada Lovelace",
      role: "admin",
      activeOrganizationId: "org_01",
    });

    await expect(
      verifier.verify(token, { signal: activeSignal() }),
    ).resolves.toEqual({
      subject: "user_01",
      email: "ada@example.com",
      emailVerified: true,
      name: "Ada Lovelace",
      role: "admin",
      activeOrganizationId: "org_01",
    });
  });

  it("keeps unexpected claims out of the verified result", async () => {
    const token = await signToken({
      email: "ada@example.com",
      passwordHash: "not-authorization-data",
      image: "https://cdn.example.com/ada.png",
    });

    const claims = await verifier.verify(token, { signal: activeSignal() });

    expect(claims).toEqual({ subject: "user_01", email: "ada@example.com" });
  });

  it("rejects a malformed token", async () => {
    await expect(
      verifier.verify("not-a-jwt", { signal: activeSignal() }),
    ).resolves.toBeNull();
  });

  it("rejects an expired token", async () => {
    const token = await signToken({}, { expiration: "-1s" });

    await expect(
      verifier.verify(token, { signal: activeSignal() }),
    ).resolves.toBeNull();
  });

  it("rejects a token from another issuer", async () => {
    const token = await signToken({}, { issuer: "https://evil.example.com" });

    await expect(
      verifier.verify(token, { signal: activeSignal() }),
    ).resolves.toBeNull();
  });

  it("rejects a token minted for another audience", async () => {
    const token = await signToken(
      {},
      { audience: "https://other.example.com" },
    );

    await expect(
      verifier.verify(token, { signal: activeSignal() }),
    ).resolves.toBeNull();
  });

  it("rejects a token signed by an unknown key", async () => {
    const token = await signToken({}, { key: otherSigningKey });

    await expect(
      verifier.verify(token, { signal: activeSignal() }),
    ).resolves.toBeNull();
  });

  it("rejects a verified token without a subject claim", async () => {
    const token = await signToken({}, { subject: null });

    await expect(
      verifier.verify(token, { signal: activeSignal() }),
    ).resolves.toBeNull();
  });

  it("reports a key-resolution outage as an infrastructure failure", async () => {
    const unavailable = createBetterAuthJwtVerifier({
      issuer,
      audience,
      keys: () => Promise.reject(new TypeError("fetch failed")),
    });
    const token = await signToken({});

    await expect(
      unavailable.verify(token, { signal: activeSignal() }),
    ).rejects.toBeInstanceOf(IdentityVerificationUnavailableError);
  });

  it("stops verifying when the request is already aborted", async () => {
    const token = await signToken({});

    await expect(
      verifier.verify(token, { signal: AbortSignal.abort() }),
    ).rejects.toBeInstanceOf(IdentityVerificationUnavailableError);
  });

  it("keeps token material out of infrastructure failure messages", async () => {
    const unavailable = createBetterAuthJwtVerifier({
      issuer,
      audience,
      keys: () => Promise.reject(new TypeError("fetch failed")),
    });
    const token = await signToken({});

    const error = await unavailable
      .verify(token, { signal: activeSignal() })
      .then(
        () => null,
        (reason: unknown) => reason,
      );

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(token);
    expect((error as Error).cause).toBeUndefined();
  });
});
