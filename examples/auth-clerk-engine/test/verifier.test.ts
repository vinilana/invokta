import {
  createLocalJWKSet,
  errors,
  exportJWK,
  generateKeyPair,
  generateSecret,
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
  /** `null` mints a token without an `exp` claim. */
  readonly expiresIn?: string | null;
  readonly key?: CryptoKey;
  readonly keyId?: string;
}

/** Mints a token in Clerk's session-token v2 claim shape from the local key. */
async function mintSessionToken(options: MintOptions = {}): Promise<string> {
  const jwt = new SignJWT({
    azp: authorizedParties[0],
    sid: "sess_2abcDEF",
    v: 2,
    sts: "active",
    ...options.claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: options.keyId ?? signingKeyId })
    .setIssuer(options.issuer ?? frontendApiUrl)
    .setSubject("user_2abcDEF")
    .setIssuedAt()
    .setNotBefore("0s");
  if (options.expiresIn !== null) {
    jwt.setExpirationTime(options.expiresIn ?? "60s");
  }
  return jwt.sign(options.key ?? signingKey);
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
  it("accepts a valid v2 session token and maps its claims to a principal", async () => {
    // Session token v2 carries the organization in the compact `o` object,
    // and its `rol` value drops the v1 `org:` prefix.
    const token = await mintSessionToken({
      claims: {
        o: { id: "org_2xyz", rol: "admin", slg: "acme" },
      },
    });

    const claims = await verifyWith(createVerifier(), token);

    expect(claims).toEqual({
      sub: "user_2abcDEF",
      sid: "sess_2abcDEF",
      org_id: "org_2xyz",
      org_role: "admin",
    });
    expect(toPrincipal(claims as NonNullable<typeof claims>)).toEqual({
      id: "user_2abcDEF",
      attributes: {
        sessionId: "sess_2abcDEF",
        organizationId: "org_2xyz",
        organizationRole: "admin",
      },
    });
  });

  it("reads the deprecated v1 organization claims and normalizes the role", async () => {
    const token = await mintSessionToken({
      claims: {
        v: 1,
        sts: undefined,
        org_id: "org_2xyz",
        org_role: "org:admin",
      },
    });

    await expect(verifyWith(createVerifier(), token)).resolves.toMatchObject({
      org_id: "org_2xyz",
      org_role: "admin",
    });
  });

  it("rejects a malformed organization object with null", async () => {
    const scalar = await mintSessionToken({ claims: { o: "org_2xyz" } });
    const emptyId = await mintSessionToken({ claims: { o: { id: "" } } });

    await expect(verifyWith(createVerifier(), scalar)).resolves.toBeNull();
    await expect(verifyWith(createVerifier(), emptyId)).resolves.toBeNull();
  });

  it("rejects a pending session with null", async () => {
    // A user who signed in but has unfinished session tasks (MFA enrollment,
    // mandatory organization selection) holds a validly signed token with
    // sts "pending"; Clerk's own SDKs treat it as signed out by default.
    const token = await mintSessionToken({ claims: { sts: "pending" } });

    await expect(verifyWith(createVerifier(), token)).resolves.toBeNull();
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

  it("passes an azp-less token by default and rejects it in strict mode", async () => {
    // Custom JWT templates and machine tokens carry no azp; the default
    // mirrors Clerk SDK semantics, and requireAuthorizedParty closes the
    // path when every legitimate caller is a session.
    const token = await mintSessionToken({ claims: { azp: undefined } });

    await expect(verifyWith(createVerifier(), token)).resolves.toMatchObject({
      sub: "user_2abcDEF",
    });

    const strict = createClerkSessionVerifier({
      frontendApiUrl,
      authorizedParties,
      requireAuthorizedParty: true,
      keys,
    });
    await expect(verifyWith(strict, token)).resolves.toBeNull();
  });

  it("rejects a signed token without an expiry with null", async () => {
    const token = await mintSessionToken({ expiresIn: null });

    await expect(verifyWith(createVerifier(), token)).resolves.toBeNull();
  });

  it("rejects a token signed outside the algorithm allowlist", async () => {
    // Pins algorithms: ["RS256"] — an HS256 token must never verify, even
    // with otherwise perfect claims.
    const secret = await generateSecret("HS256", { extractable: true });
    const token = await new SignJWT({
      azp: authorizedParties[0],
      sid: "sess_2abcDEF",
      v: 2,
      sts: "active",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(frontendApiUrl)
      .setSubject("user_2abcDEF")
      .setIssuedAt()
      .setExpirationTime("60s")
      .sign(secret);

    await expect(verifyWith(createVerifier(), token)).resolves.toBeNull();
  });

  it("throws when the key set is ambiguous for the token", async () => {
    // Two same-algorithm keys without kid headers: jose cannot pick a
    // candidate, which is the instance's key-publication problem, not proof
    // against the credential — so it surfaces as unavailable, not null.
    const first = await generateKeyPair("RS256", { extractable: true });
    const second = await generateKeyPair("RS256", { extractable: true });
    const ambiguous = createLocalJWKSet({
      keys: [
        { ...(await exportJWK(first.publicKey)), alg: "RS256", use: "sig" },
        { ...(await exportJWK(second.publicKey)), alg: "RS256", use: "sig" },
      ],
    });
    const token = await new SignJWT({
      azp: authorizedParties[0],
      sid: "sess_2abcDEF",
      v: 2,
      sts: "active",
    })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(frontendApiUrl)
      .setSubject("user_2abcDEF")
      .setIssuedAt()
      .setExpirationTime("60s")
      .sign(first.privateKey);

    await expect(
      verifyWith(createVerifier({ keys: ambiguous }), token),
    ).rejects.toBeInstanceOf(ClerkVerificationUnavailableError);
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
