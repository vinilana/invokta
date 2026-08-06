import {
  createLocalJWKSet,
  errors,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTVerifyGetKey,
  SignJWT,
} from "jose";
import { describe, expect, it } from "vitest";

import { toPrincipal } from "../src/identity/principal.js";
import {
  createWorkOsAccessTokenVerifier,
  WorkOsVerificationUnavailableError,
  workOsAuthKitJwksUrl,
  workOsJwksUrl,
} from "../src/identity/verifier.js";

const clientId = "client_01JTESTCLIENTID";
const issuer = "https://api.workos.com/";
const audience = "https://engine.example.com/mcp";
const keyId = "workos-test-key";

const signing = await generateKeyPair("RS256", { extractable: true });
const other = await generateKeyPair("RS256", { extractable: true });

async function publicJwk(publicKey: CryptoKey): Promise<JWK> {
  return {
    ...(await exportJWK(publicKey)),
    kid: keyId,
    alg: "RS256",
    use: "sig",
  };
}

const keys: JWTVerifyGetKey = createLocalJWKSet({
  keys: [await publicJwk(signing.publicKey)],
});

interface TokenOptions {
  readonly subject?: string;
  readonly issuer?: string;
  readonly audience?: string;
  /** `null` mints a token without an `exp` claim. */
  readonly expiresIn?: string | null;
  readonly claims?: Readonly<Record<string, unknown>>;
  readonly privateKey?: CryptoKey;
}

async function mintAccessToken(options: TokenOptions = {}): Promise<string> {
  const jwt = new SignJWT({ ...options.claims })
    .setProtectedHeader({ alg: "RS256", kid: keyId })
    .setSubject(options.subject ?? "user_01JTESTUSER")
    .setIssuer(options.issuer ?? issuer)
    .setAudience(options.audience ?? audience)
    .setIssuedAt();
  if (options.expiresIn !== null) {
    jwt.setExpirationTime(options.expiresIn ?? "5m");
  }
  return jwt.sign(options.privateKey ?? signing.privateKey);
}

function createVerifier(overrides: { readonly keys?: JWTVerifyGetKey } = {}) {
  return createWorkOsAccessTokenVerifier({
    clientId,
    audience,
    keys: overrides.keys ?? keys,
  });
}

function activeSignal(): AbortSignal {
  return new AbortController().signal;
}

describe("WorkOS JWKS URL", () => {
  it("derives the client-scoped JWKS endpoint", () => {
    expect(workOsJwksUrl(clientId).href).toBe(
      `https://api.workos.com/sso/jwks/${clientId}`,
    );
  });

  it("supports a custom auth domain", () => {
    expect(workOsJwksUrl(clientId, "https://auth.example.com").href).toBe(
      `https://auth.example.com/sso/jwks/${clientId}`,
    );
  });

  it("derives the AuthKit-domain OAuth JWKS endpoint", () => {
    expect(workOsAuthKitJwksUrl("https://example-env.authkit.app").href).toBe(
      "https://example-env.authkit.app/oauth2/jwks",
    );
    expect(() =>
      workOsAuthKitJwksUrl("http://example-env.authkit.app"),
    ).toThrow(/HTTPS/u);
    expect(() => workOsAuthKitJwksUrl("not-a-url")).toThrow(/AuthKit/u);
  });

  it("rejects an empty client id", () => {
    expect(() => workOsJwksUrl("")).toThrow();
  });
});

describe("WorkOS access token verifier", () => {
  it("accepts a valid AuthKit access token", async () => {
    const token = await mintAccessToken({
      claims: {
        sid: "session_01JTESTSESSION",
        org_id: "org_01JTESTORG",
        role: "admin",
        permissions: ["widgets:read", "widgets:write"],
      },
    });

    await expect(
      createVerifier().verify(token, { signal: activeSignal() }),
    ).resolves.toEqual({
      sub: "user_01JTESTUSER",
      sid: "session_01JTESTSESSION",
      org_id: "org_01JTESTORG",
      role: "admin",
      permissions: ["widgets:read", "widgets:write"],
    });
  });

  it("returns null for a malformed token", async () => {
    await expect(
      createVerifier().verify("not-a-jwt", { signal: activeSignal() }),
    ).resolves.toBeNull();
  });

  it("returns null for an empty token", async () => {
    await expect(
      createVerifier().verify("", { signal: activeSignal() }),
    ).resolves.toBeNull();
  });

  it("returns null for an expired token", async () => {
    const token = await mintAccessToken({ expiresIn: "-1m" });

    await expect(
      createVerifier().verify(token, { signal: activeSignal() }),
    ).resolves.toBeNull();
  });

  it("returns null for the wrong issuer", async () => {
    const token = await mintAccessToken({
      issuer: "https://evil.example.com/",
    });

    await expect(
      createVerifier().verify(token, { signal: activeSignal() }),
    ).resolves.toBeNull();
  });

  it("returns null for the wrong audience", async () => {
    const token = await mintAccessToken({
      audience: "https://other.example.com/mcp",
    });

    await expect(
      createVerifier().verify(token, { signal: activeSignal() }),
    ).resolves.toBeNull();
  });

  it("returns null for a bad signature", async () => {
    const token = await mintAccessToken({ privateKey: other.privateKey });

    await expect(
      createVerifier().verify(token, { signal: activeSignal() }),
    ).resolves.toBeNull();
  });

  it("returns null when the token has no subject", async () => {
    const token = await new SignJWT({ sid: "session_01JTESTSESSION" })
      .setProtectedHeader({ alg: "RS256", kid: keyId })
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(signing.privateKey);

    await expect(
      createVerifier().verify(token, { signal: activeSignal() }),
    ).resolves.toBeNull();
  });

  it("returns null for a signed token without an expiry", async () => {
    const token = await mintAccessToken({ expiresIn: null });

    await expect(
      createVerifier().verify(token, { signal: activeSignal() }),
    ).resolves.toBeNull();
  });

  it("returns null for a token signed outside the algorithm allowlist", async () => {
    // Pins algorithms: ["RS256"] — an HS256 token must never verify, even
    // with otherwise perfect claims.
    const { generateSecret } = await import("jose");
    const secret = await generateSecret("HS256", { extractable: true });
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("user_01JTESTUSER")
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(secret);

    await expect(
      createVerifier().verify(token, { signal: activeSignal() }),
    ).resolves.toBeNull();
  });

  it("throws when the key set is ambiguous for the token", async () => {
    // Two same-algorithm keys without kid headers: jose cannot pick a
    // candidate, which is the environment's key-publication problem, not
    // proof against the credential — so it surfaces as unavailable, not null.
    const ambiguous = createLocalJWKSet({
      keys: [
        { ...(await exportJWK(signing.publicKey)), alg: "RS256", use: "sig" },
        { ...(await exportJWK(other.publicKey)), alg: "RS256", use: "sig" },
      ],
    });
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setSubject("user_01JTESTUSER")
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(signing.privateKey);

    await expect(
      createVerifier({ keys: ambiguous }).verify(token, {
        signal: activeSignal(),
      }),
    ).rejects.toBeInstanceOf(WorkOsVerificationUnavailableError);
  });

  it("returns null when no JWKS key matches the token", async () => {
    const unmatched: JWTVerifyGetKey = createLocalJWKSet({
      keys: [{ ...(await publicJwk(other.publicKey)), kid: "another-key" }],
    });
    const token = await mintAccessToken();

    await expect(
      createVerifier({ keys: unmatched }).verify(token, {
        signal: activeSignal(),
      }),
    ).resolves.toBeNull();
  });

  it("throws when key resolution is unavailable", async () => {
    const unavailable: JWTVerifyGetKey = () => {
      throw new errors.JWKSTimeout();
    };
    const token = await mintAccessToken();

    await expect(
      createVerifier({ keys: unavailable }).verify(token, {
        signal: activeSignal(),
      }),
    ).rejects.toBeInstanceOf(WorkOsVerificationUnavailableError);
  });

  it("throws without leaking the token when key resolution fails", async () => {
    const unavailable: JWTVerifyGetKey = () => {
      throw new TypeError(`fetch failed for ${workOsJwksUrl(clientId).href}`);
    };
    const token = await mintAccessToken();

    const failure = await createVerifier({ keys: unavailable })
      .verify(token, { signal: activeSignal() })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(WorkOsVerificationUnavailableError);
    expect((failure as Error).message).not.toContain(token);
    expect((failure as Error).cause).toBeUndefined();
  });

  it("stops when the request is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const token = await mintAccessToken();

    await expect(
      createVerifier().verify(token, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(WorkOsVerificationUnavailableError);
  });

  it("stops when the request is aborted while verification is pending", async () => {
    const controller = new AbortController();
    const pending: JWTVerifyGetKey = () => new Promise(() => undefined);
    const token = await mintAccessToken();
    const verification = createVerifier({ keys: pending }).verify(token, {
      signal: controller.signal,
    });
    controller.abort();

    await expect(verification).rejects.toBeInstanceOf(
      WorkOsVerificationUnavailableError,
    );
  });

  it("bounds its own wait when key resolution never settles", async () => {
    const pending: JWTVerifyGetKey = () => new Promise(() => undefined);
    const token = await mintAccessToken();

    await expect(
      createWorkOsAccessTokenVerifier({
        clientId,
        audience,
        keys: pending,
        timeoutMs: 20,
      }).verify(token, { signal: activeSignal() }),
    ).rejects.toBeInstanceOf(WorkOsVerificationUnavailableError);
  });

  it("skips audience validation when the deployment configures none", async () => {
    const token = await mintAccessToken({ audience: "anything" });

    await expect(
      createWorkOsAccessTokenVerifier({ clientId, keys }).verify(token, {
        signal: activeSignal(),
      }),
    ).resolves.toMatchObject({ sub: "user_01JTESTUSER" });
  });
});

describe("WorkOS claims to principal", () => {
  it("maps organization claims into principal attributes", () => {
    expect(
      toPrincipal({
        sub: "user_01JTESTUSER",
        sid: "session_01JTESTSESSION",
        org_id: "org_01JTESTORG",
        role: "admin",
        permissions: ["widgets:read"],
      }),
    ).toEqual({
      id: "user_01JTESTUSER",
      attributes: {
        sid: "session_01JTESTSESSION",
        org_id: "org_01JTESTORG",
        role: "admin",
        permissions: ["widgets:read"],
      },
    });
  });

  it("omits organization claims that the token does not carry", () => {
    expect(toPrincipal({ sub: "user_01JTESTUSER" })).toEqual({
      id: "user_01JTESTUSER",
    });
  });

  it("produces a structured-cloneable principal with a non-empty id", () => {
    const principal = toPrincipal({
      sub: "user_01JTESTUSER",
      org_id: "org_01JTESTORG",
    });

    expect(structuredClone(principal)).toEqual(principal);
    expect(principal.id.length).toBeGreaterThan(0);
  });

  it("keeps every unmapped claim out of the principal", async () => {
    const token = await mintAccessToken({
      claims: {
        sid: "session_01JTESTSESSION",
        org_id: "org_01JTESTORG",
        role: "admin",
        permissions: ["widgets:read"],
        email: "person@example.com",
        entitlements: ["billing"],
      },
    });
    const claims = await createVerifier().verify(token, {
      signal: activeSignal(),
    });
    if (claims === null) throw new Error("Expected verified claims.");
    const serialized = JSON.stringify(toPrincipal(claims));

    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("person@example.com");
    expect(serialized).not.toContain("entitlements");
    expect(serialized).not.toContain(issuer);
    expect(serialized).not.toContain(audience);
  });
});
