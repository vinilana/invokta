import {
  createLocalJWKSet,
  errors,
  exportJWK,
  generateKeyPair,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
  SignJWT,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import { toPrincipal } from "../src/identity/principal.js";
import {
  ClerkVerificationUnavailableError,
  clerkJwksUrl,
  createClerkSessionVerifier,
} from "../src/identity/verifier.js";

const frontendApiUrl = "https://clean-mayfly-62.clerk.accounts.dev";
const authorizedParties = ["https://app.example.com"] as const;
const signingKeyId = "ins_test_signing_key";

let signingKey: CryptoKey;
let otherSigningKey: CryptoKey;
let keys: JWTVerifyGetKey;

async function publicJwk(key: CryptoKey, kid: string) {
  return { ...(await exportJWK(key)), alg: "RS256", kid, use: "sig" };
}

beforeAll(async () => {
  const instanceKeys = await generateKeyPair("RS256", { extractable: true });
  const foreignKeys = await generateKeyPair("RS256", { extractable: true });
  signingKey = instanceKeys.privateKey;
  otherSigningKey = foreignKeys.privateKey;
  const jwks: JSONWebKeySet = {
    keys: [await publicJwk(instanceKeys.publicKey, signingKeyId)],
  };
  keys = createLocalJWKSet(jwks);
});

interface MintOptions {
  readonly claims?: Readonly<Record<string, unknown>>;
  readonly issuer?: string;
  readonly expiresIn?: string;
  readonly key?: CryptoKey;
  readonly keyId?: string;
}

/** Mints a token in Clerk's session-token claim shape from the local key. */
async function mintSessionToken(options: MintOptions = {}): Promise<string> {
  return new SignJWT({
    azp: authorizedParties[0],
    sid: "sess_2abcDEF",
    ...options.claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: options.keyId ?? signingKeyId })
    .setIssuer(options.issuer ?? frontendApiUrl)
    .setSubject("user_2abcDEF")
    .setIssuedAt()
    .setNotBefore("0s")
    .setExpirationTime(options.expiresIn ?? "60s")
    .sign(options.key ?? signingKey);
}

function createVerifier(overrides: { readonly keys?: JWTVerifyGetKey } = {}) {
  return createClerkSessionVerifier({
    frontendApiUrl,
    authorizedParties,
    keys: overrides.keys ?? keys,
  });
}

function verifyWith(
  verifier: ReturnType<typeof createVerifier>,
  token: string,
) {
  return verifier.verify(token, { signal: AbortSignal.timeout(5_000) });
}

describe("clerk JWKS location", () => {
  it("derives the instance JWKS from the Frontend API URL", () => {
    expect(clerkJwksUrl(frontendApiUrl).href).toBe(
      "https://clean-mayfly-62.clerk.accounts.dev/.well-known/jwks.json",
    );
    expect(clerkJwksUrl("https://clerk.example.com/").href).toBe(
      "https://clerk.example.com/.well-known/jwks.json",
    );
  });

  it("refuses a Frontend API URL that is not HTTPS", () => {
    expect(() => clerkJwksUrl("http://clerk.example.com")).toThrow();
  });
});

describe("clerk session verifier", () => {
  it("accepts a valid session token and maps its claims to a principal", async () => {
    const token = await mintSessionToken({
      claims: {
        azp: authorizedParties[0],
        sid: "sess_2abcDEF",
        org_id: "org_2xyz",
        org_role: "org:admin",
      },
    });

    const claims = await verifyWith(createVerifier(), token);

    expect(claims).toEqual({
      sub: "user_2abcDEF",
      sid: "sess_2abcDEF",
      org_id: "org_2xyz",
      org_role: "org:admin",
    });
    expect(toPrincipal(claims as NonNullable<typeof claims>)).toEqual({
      id: "user_2abcDEF",
      attributes: {
        sessionId: "sess_2abcDEF",
        organizationId: "org_2xyz",
        organizationRole: "org:admin",
      },
    });
  });

  it("omits organization attributes for a personal-account session", async () => {
    const token = await mintSessionToken();

    const claims = await verifyWith(createVerifier(), token);

    expect(claims).toEqual({ sub: "user_2abcDEF", sid: "sess_2abcDEF" });
    expect(toPrincipal(claims as NonNullable<typeof claims>)).toEqual({
      id: "user_2abcDEF",
      attributes: { sessionId: "sess_2abcDEF" },
    });
  });

  it("keeps the token itself out of the principal", async () => {
    const token = await mintSessionToken();

    const claims = await verifyWith(createVerifier(), token);
    const principal = toPrincipal(claims as NonNullable<typeof claims>);

    const serialized = JSON.stringify(principal);
    expect(serialized).not.toContain(token);
    for (const segment of token.split(".")) {
      expect(serialized).not.toContain(segment);
    }
  });

  it.each([
    ["an empty credential", ""],
    ["a malformed credential", "not-a-jwt"],
    ["a truncated compact JWS", "aaa.bbb"],
  ])("rejects %s with null", async (_label, token) => {
    await expect(verifyWith(createVerifier(), token)).resolves.toBeNull();
  });

  it("rejects an expired session token with null", async () => {
    const token = await mintSessionToken({ expiresIn: "-60s" });

    await expect(verifyWith(createVerifier(), token)).resolves.toBeNull();
  });

  it("rejects a token from another issuer with null", async () => {
    const token = await mintSessionToken({
      issuer: "https://other-instance.clerk.accounts.dev",
    });

    await expect(verifyWith(createVerifier(), token)).resolves.toBeNull();
  });

  it("rejects an unlisted authorized party with null", async () => {
    const token = await mintSessionToken({
      claims: { azp: "https://attacker.example.com", sid: "sess_2abcDEF" },
    });

    await expect(verifyWith(createVerifier(), token)).resolves.toBeNull();
  });

  it("rejects a token signed by another key with null", async () => {
    const token = await mintSessionToken({ key: otherSigningKey });

    await expect(verifyWith(createVerifier(), token)).resolves.toBeNull();
  });

  it("rejects an unknown signing key id with null", async () => {
    const token = await mintSessionToken({ keyId: "ins_rotated_away" });

    await expect(verifyWith(createVerifier(), token)).resolves.toBeNull();
  });

  it("rejects a token whose subject is missing with null", async () => {
    const token = await new SignJWT({ azp: authorizedParties[0] })
      .setProtectedHeader({ alg: "RS256", kid: signingKeyId })
      .setIssuer(frontendApiUrl)
      .setIssuedAt()
      .setExpirationTime("60s")
      .sign(signingKey);

    await expect(verifyWith(createVerifier(), token)).resolves.toBeNull();
  });

  it("throws when key resolution cannot complete", async () => {
    const token = await mintSessionToken();
    const unavailable = createVerifier({
      keys: () => Promise.reject(new errors.JWKSTimeout()),
    });

    await expect(verifyWith(unavailable, token)).rejects.toBeInstanceOf(
      ClerkVerificationUnavailableError,
    );
  });

  it("throws without repeating the credential in the failure message", async () => {
    const token = await mintSessionToken();
    const unavailable = createVerifier({
      keys: () => Promise.reject(new TypeError("fetch failed")),
    });

    const failure = await verifyWith(unavailable, token).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ClerkVerificationUnavailableError);
    expect((failure as Error).message).not.toContain(token);
    expect((failure as Error).message).toBe(
      "Clerk session verification is unavailable.",
    );
  });

  it("stops verification when the request is already aborted", async () => {
    const token = await mintSessionToken();
    const verifier = createVerifier({
      keys: () => new Promise(() => undefined),
    });

    await expect(
      verifier.verify(token, { signal: AbortSignal.abort() }),
    ).rejects.toBeInstanceOf(ClerkVerificationUnavailableError);
  });
});
