import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  generateSecret,
  type JWTVerifyGetKey,
  SignJWT,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import { toSupabasePrincipal } from "../src/identity/principal.js";
import {
  createSupabaseVerifier,
  SupabaseVerificationUnavailableError,
  supabaseIssuer,
  supabaseJwksUrl,
} from "../src/identity/verifier.js";
import {
  createTokenFactory,
  issuer,
  projectUrl,
  type SupabaseTokenFactory,
  sessionId,
  subject,
} from "./tokens.js";

let tokens: SupabaseTokenFactory;

function verifier(keys?: JWTVerifyGetKey) {
  return createSupabaseVerifier({ issuer, keys: keys ?? tokens.keys });
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

beforeAll(async () => {
  tokens = await createTokenFactory();
});

describe("Supabase project URLs", () => {
  it("derives the issuer and JWKS endpoint from the project URL", () => {
    expect(supabaseIssuer(`${projectUrl}/`)).toBe(issuer);
    expect(supabaseJwksUrl(projectUrl)).toBe(`${issuer}/.well-known/jwks.json`);
  });

  it("rejects a project URL that is not an HTTPS origin", () => {
    expect(() => supabaseIssuer("ftp://example.com")).toThrow(TypeError);
    expect(() => supabaseIssuer("not a url")).toThrow(TypeError);
  });
});

describe("Supabase access token verification", () => {
  it("accepts a token signed by the project key", async () => {
    const token = await tokens.sign();

    await expect(
      verifier().verify(token, { signal: signal() }),
    ).resolves.toEqual({
      subject,
      role: "authenticated",
      email: "ada@example.com",
      sessionId,
      isAnonymous: false,
    });
  });

  it("keeps optional claims out of the identity when absent", async () => {
    const token = await tokens.sign({
      email: undefined,
      session_id: undefined,
      is_anonymous: undefined,
    });

    await expect(
      verifier().verify(token, { signal: signal() }),
    ).resolves.toEqual({
      subject,
      role: "authenticated",
      email: null,
      sessionId: null,
      isAnonymous: null,
    });
  });

  it("verifies an anonymous sign-in session and exposes is_anonymous", async () => {
    // Anonymous sign-ins carry aud "authenticated" and role "authenticated";
    // the is_anonymous claim is the only distinguishing mark, so it must reach
    // the identity for an access rule to act on.
    const token = await tokens.sign({ is_anonymous: true });

    await expect(
      verifier().verify(token, { signal: signal() }),
    ).resolves.toMatchObject({ subject, isAnonymous: true });
  });

  it.each([
    ["a malformed credential", async () => "not-a-supabase-token"],
    ["an empty credential", async () => ""],
    [
      "an expired token",
      async () =>
        tokens.sign({}, { expiresAt: Math.floor(Date.now() / 1000) - 3_600 }),
    ],
    [
      "a token from another project",
      async () =>
        tokens.sign(
          {},
          { issuer: "https://other-project.supabase.co/auth/v1" },
        ),
    ],
    [
      "an anonymous-audience token",
      async () => tokens.sign({}, { audience: "anon" }),
    ],
    [
      "a token signed by an unknown key",
      async () =>
        tokens.sign({}, { signWith: "attacker", keyId: "unknown-kid" }),
    ],
    [
      "a token whose signature does not match the advertised key",
      async () => tokens.sign({}, { signWith: "attacker" }),
    ],
    [
      "a token without a subject",
      async () => tokens.sign({}, { subject: null }),
    ],
    [
      "a token with a blank subject",
      async () => tokens.sign({}, { subject: "   " }),
    ],
    [
      "a signed token without an expiry",
      async () => tokens.sign({}, { expiresAt: null }),
    ],
  ])("returns null for %s", async (_label, mint) => {
    await expect(
      verifier().verify(await mint(), { signal: signal() }),
    ).resolves.toBeNull();
  });

  it("returns null for a legacy HS256 shared-secret token", async () => {
    const secret = await generateSecret("HS256", { extractable: true });
    const legacy = await new SignJWT({ role: "authenticated" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(subject)
      .setIssuer(issuer)
      .setAudience("authenticated")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(secret);

    await expect(
      verifier().verify(legacy, { signal: signal() }),
    ).resolves.toBeNull();
  });

  it("rejects when the key set is ambiguous for the token", async () => {
    // Two same-algorithm keys without kid headers: jose cannot pick a
    // candidate, which is the project's key-publication problem, not proof
    // against the credential — so it must surface as unavailable, not null.
    const first = await generateKeyPair("ES256", { extractable: true });
    const second = await generateKeyPair("ES256", { extractable: true });
    const ambiguous = createLocalJWKSet({
      keys: [
        { ...(await exportJWK(first.publicKey)), alg: "ES256", use: "sig" },
        { ...(await exportJWK(second.publicKey)), alg: "ES256", use: "sig" },
      ],
    });
    const token = await new SignJWT({ role: "authenticated" })
      .setProtectedHeader({ alg: "ES256" })
      .setSubject(subject)
      .setIssuer(issuer)
      .setAudience("authenticated")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(first.privateKey);

    await expect(
      verifier(ambiguous).verify(token, { signal: signal() }),
    ).rejects.toBeInstanceOf(SupabaseVerificationUnavailableError);
  });

  it("rejects when key resolution fails for an infrastructure reason", async () => {
    const unavailable = verifier(() =>
      Promise.reject(new Error("getaddrinfo ENOTFOUND supabase.co")),
    );

    await expect(
      unavailable.verify(await tokens.sign(), { signal: signal() }),
    ).rejects.toBeInstanceOf(SupabaseVerificationUnavailableError);
  });

  it("does not leak the failure cause into the raised error", async () => {
    const token = await tokens.sign();
    const unavailable = verifier(() =>
      Promise.reject(new Error(`JWKS fetch failed for ${token}`)),
    );

    const error = await unavailable.verify(token, { signal: signal() }).then(
      () => null,
      (raised: unknown) => raised as Error,
    );

    expect(error).toBeInstanceOf(SupabaseVerificationUnavailableError);
    expect(`${error?.message}${error?.stack ?? ""}`).not.toContain(token);
  });

  it("stops waiting when the request is aborted", async () => {
    const controller = new AbortController();
    const pending = verifier(() => new Promise(() => undefined)).verify(
      await tokens.sign(),
      { signal: controller.signal },
    );
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(
      SupabaseVerificationUnavailableError,
    );
  });

  it("bounds its own verification time", async () => {
    const slow = createSupabaseVerifier({
      issuer,
      keys: () => new Promise(() => undefined),
      timeoutMs: 10,
    });

    await expect(
      slow.verify(await tokens.sign(), { signal: signal() }),
    ).rejects.toBeInstanceOf(SupabaseVerificationUnavailableError);
  });

  it("never copies credential material into the principal", async () => {
    const token = await tokens.sign();
    const identity = await verifier().verify(token, { signal: signal() });
    const principal = toSupabasePrincipal(
      identity ?? {
        subject,
        role: null,
        email: null,
        sessionId: null,
        isAnonymous: null,
      },
    );

    const serialized = JSON.stringify(principal);
    expect(serialized).not.toContain(token);
    for (const segment of token.split(".")) {
      expect(serialized).not.toContain(segment);
    }
    expect(structuredClone(principal)).toEqual(principal);
    expect(principal.id).toBe(subject);
    expect(principal.attributes).toEqual({
      role: "authenticated",
      email: "ada@example.com",
      sessionId,
      isAnonymous: false,
    });
  });
});
