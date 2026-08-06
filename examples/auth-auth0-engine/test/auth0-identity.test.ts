import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  generateSecret,
  SignJWT,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import { engine } from "../src/engine.js";
import { toAuth0Principal } from "../src/identity/principal.js";
import {
  Auth0VerificationUnavailableError,
  auth0Issuer,
  auth0JwksUri,
  createAuth0AccessTokenVerifier,
} from "../src/identity/verifier.js";
import { createAuth0Authenticate } from "../src/mcp-http.js";
import {
  type Auth0TokenFactory,
  createAuth0TokenFactory,
  foreignKeyId,
  testAudience,
  testDomain,
  testIssuer,
  validClaims,
} from "./support/auth0-tokens.js";

let tokens: Auth0TokenFactory;

beforeAll(async () => {
  tokens = await createAuth0TokenFactory();
});

function verifier(keySource = tokens.keySource) {
  return createAuth0AccessTokenVerifier({
    domain: testDomain,
    audience: testAudience,
    keySource,
  });
}

function headerView(authorization?: string) {
  const headers = new Map<string, string>(
    authorization === undefined ? [] : [["authorization", authorization]],
  );
  return {
    get: (name: string) => headers.get(name.toLowerCase()) ?? null,
    has: (name: string) => headers.has(name.toLowerCase()),
  };
}

function authenticationRequest(authorization?: string) {
  return {
    path: "/mcp",
    method: "POST",
    headers: headerView(authorization),
    signal: new AbortController().signal,
  };
}

describe("auth0 issuer derivation", () => {
  it("mints the trailing-slash issuer Auth0 puts in the iss claim", () => {
    expect(auth0Issuer("tenant.eu.auth0.com")).toBe(
      "https://tenant.eu.auth0.com/",
    );
    expect(auth0Issuer("https://tenant.eu.auth0.com")).toBe(
      "https://tenant.eu.auth0.com/",
    );
    expect(auth0Issuer("https://tenant.eu.auth0.com/")).toBe(
      "https://tenant.eu.auth0.com/",
    );
  });

  it("derives the tenant JWKS document from the issuer", () => {
    expect(auth0JwksUri("tenant.eu.auth0.com").href).toBe(
      "https://tenant.eu.auth0.com/.well-known/jwks.json",
    );
  });

  it("refuses a domain that is not an HTTPS origin", () => {
    expect(() => auth0Issuer("http://tenant.eu.auth0.com")).toThrow(TypeError);
    expect(() => auth0Issuer("   ")).toThrow(TypeError);
  });
});

describe("auth0 access token verification", () => {
  it("accepts a token signed for the registered API", async () => {
    const token = await tokens.sign(validClaims());

    const claims = await verifier().verify(token, {
      signal: new AbortController().signal,
    });

    expect(claims?.sub).toBe("auth0|64f0c0ffee0000000000abcd");
    expect(claims?.iss).toBe(testIssuer);
  });

  it.each([
    [
      "an expired token",
      async () => {
        const issuedAt = Math.floor(Date.now() / 1000) - 7200;
        return tokens.sign(validClaims(), {
          issuedAt,
          expiresAt: issuedAt + 60,
        });
      },
    ],
    [
      "another tenant's issuer",
      async () =>
        tokens.sign(validClaims({ iss: "https://other.eu.auth0.com/" })),
    ],
    [
      "an issuer without the trailing slash",
      async () => tokens.sign(validClaims({ iss: `https://${testDomain}` })),
    ],
    [
      "another API audience",
      async () =>
        tokens.sign(validClaims({ aud: "https://billing.example.com" })),
    ],
    [
      "a missing audience",
      async () => {
        const { aud: _aud, ...rest } = validClaims();
        return tokens.sign(rest);
      },
    ],
    [
      "an unknown signing key",
      async () => tokens.sign(validClaims(), { keyId: foreignKeyId }),
    ],
    [
      "a forged signature",
      async () => tokens.signWithForeignKey(validClaims()),
    ],
    ["a malformed token", async () => "not-a-json-web-token"],
    ["an empty token", async () => ""],
    [
      "a signed token without an expiry",
      async () => tokens.sign(validClaims(), { expiresAt: null }),
    ],
  ])("rejects %s with null", async (_label, build) => {
    const token = await build();

    await expect(
      verifier().verify(token, { signal: new AbortController().signal }),
    ).resolves.toBeNull();
  });

  it("rejects a token signed outside the algorithm allowlist", async () => {
    // Pins algorithms: ["RS256"] — an HS256 token must never verify, even
    // with otherwise perfect claims.
    const secret = await generateSecret("HS256", { extractable: true });
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT(validClaims())
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(secret);

    await expect(
      verifier().verify(token, { signal: new AbortController().signal }),
    ).resolves.toBeNull();
  });

  it("throws when the key set is ambiguous for the token", async () => {
    // Two same-algorithm keys without kid headers: jose cannot pick a
    // candidate, which is the tenant's key-publication problem, not proof
    // against the credential — so it surfaces as unavailable, not null.
    const first = await generateKeyPair("RS256", { extractable: true });
    const second = await generateKeyPair("RS256", { extractable: true });
    const ambiguous = createLocalJWKSet({
      keys: [
        { ...(await exportJWK(first.publicKey)), alg: "RS256", use: "sig" },
        { ...(await exportJWK(second.publicKey)), alg: "RS256", use: "sig" },
      ],
    });
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT(validClaims())
      .setProtectedHeader({ alg: "RS256" })
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(first.privateKey);

    await expect(
      verifier(ambiguous).verify(token, {
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(Auth0VerificationUnavailableError);
  });

  it("throws when key resolution itself fails", async () => {
    const token = await tokens.sign(validClaims());

    await expect(
      verifier(tokens.failingKeySource).verify(token, {
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(Auth0VerificationUnavailableError);
  });

  it("stops when the request is already aborted", async () => {
    const token = await tokens.sign(validClaims());
    const controller = new AbortController();
    controller.abort();

    await expect(
      verifier().verify(token, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(Auth0VerificationUnavailableError);
  });

  it("keeps token material out of the failure message", async () => {
    const token = await tokens.sign(validClaims());

    const failure = await verifier(tokens.failingKeySource)
      .verify(token, { signal: new AbortController().signal })
      .catch((error: unknown) => error);

    expect(String(failure)).not.toContain(token);
    expect(String(failure)).not.toContain("JWKS endpoint refused.");
  });
});

describe("auth0 claims to principal", () => {
  it("maps sub, scope, and RBAC permissions", () => {
    const principal = toAuth0Principal(
      validClaims({ permissions: ["orders:read", "orders:write"] }),
    );

    expect(principal).toEqual({
      id: "auth0|64f0c0ffee0000000000abcd",
      attributes: {
        scopes: ["openid", "profile", "orders:read", "orders:write"],
        permissions: ["orders:read", "orders:write"],
      },
    });
  });

  it("omits permissions when RBAC does not add the claim", () => {
    const principal = toAuth0Principal(validClaims());

    expect(principal?.attributes).toEqual({
      scopes: ["openid", "profile", "orders:read", "orders:write"],
    });
  });

  it("omits a malformed permissions claim instead of trusting it", () => {
    const principal = toAuth0Principal(
      validClaims({ permissions: ["orders:read", 7] }),
    );

    expect(principal?.attributes).not.toHaveProperty("permissions");
  });

  it("reports an empty scope claim as no scopes", () => {
    const { scope: _scope, ...rest } = validClaims();

    expect(toAuth0Principal(rest)?.attributes).toEqual({ scopes: [] });
  });

  it("refuses a token without a usable subject", () => {
    const { sub: _sub, ...withoutSubject } = validClaims();

    expect(toAuth0Principal(validClaims({ sub: "" }))).toBeNull();
    expect(toAuth0Principal(withoutSubject)).toBeNull();
  });
});

describe("auth0 authentication hook", () => {
  it("produces the principal an authenticated request proves", async () => {
    const token = await tokens.sign(
      validClaims({ permissions: ["orders:read"] }),
    );
    const authenticate = createAuth0Authenticate(verifier());

    const principal = await authenticate(
      authenticationRequest(`Bearer ${token}`),
    );

    expect(principal).toEqual({
      id: "auth0|64f0c0ffee0000000000abcd",
      attributes: {
        scopes: ["openid", "profile", "orders:read", "orders:write"],
        permissions: ["orders:read"],
      },
    });
  });

  it("accepts the authentication scheme case-insensitively", async () => {
    // RFC 9110 makes the scheme token case-insensitive.
    const token = await tokens.sign(validClaims());
    const authenticate = createAuth0Authenticate(verifier());

    await expect(
      authenticate(authenticationRequest(`bearer ${token}`)),
    ).resolves.toMatchObject({ id: "auth0|64f0c0ffee0000000000abcd" });
  });

  it("never carries credential material into the principal", async () => {
    const token = await tokens.sign(validClaims());
    const authenticate = createAuth0Authenticate(verifier());

    const principal = await authenticate(
      authenticationRequest(`Bearer ${token}`),
    );

    const serialized = JSON.stringify(principal);
    expect(serialized).not.toContain(token);
    for (const segment of token.split(".")) {
      expect(serialized).not.toContain(segment);
    }
    expect(serialized).not.toContain("azp");
  });

  it.each([
    ["a missing Authorization header", undefined],
    ["an empty Authorization header", ""],
    ["a non-bearer scheme", "Basic dXNlcjpwYXNz"],
    ["a bearer scheme without a token", "Bearer"],
    ["a malformed bearer token", "Bearer not-a-json-web-token"],
  ])("answers null for %s", async (_label, authorization) => {
    const authenticate = createAuth0Authenticate(verifier());

    await expect(
      authenticate(authenticationRequest(authorization)),
    ).resolves.toBeNull();
  });

  it("propagates an infrastructure failure so the adapter answers 500", async () => {
    const token = await tokens.sign(validClaims());
    const authenticate = createAuth0Authenticate(
      verifier(tokens.failingKeySource),
    );

    await expect(
      authenticate(authenticationRequest(`Bearer ${token}`)),
    ).rejects.toBeInstanceOf(Auth0VerificationUnavailableError);
  });
});

describe("identity.whoami", () => {
  it("echoes the verified identity of an authenticated caller", async () => {
    const token = await tokens.sign(
      validClaims({ permissions: ["orders:read"] }),
    );
    const authenticate = createAuth0Authenticate(verifier());
    const principal = await authenticate(
      authenticationRequest(`Bearer ${token}`),
    );

    await expect(
      engine.invoke("identity.whoami", {}, { source: "mcp-http", principal }),
    ).resolves.toEqual({
      principalId: "auth0|64f0c0ffee0000000000abcd",
      attributes: {
        scopes: ["openid", "profile", "orders:read", "orders:write"],
        permissions: ["orders:read"],
      },
    });
  });

  it("denies an anonymous caller", async () => {
    await expect(
      engine.invoke("identity.whoami", {}, { principal: null }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("ignores identity supplied as capability input", async () => {
    await expect(
      engine.invoke(
        "identity.whoami",
        { principalId: "attacker" } as unknown as Record<string, never>,
        { principal: { id: "auth0|real", attributes: { scopes: [] } } },
      ),
    ).resolves.toEqual({
      principalId: "auth0|real",
      attributes: { scopes: [] },
    });
  });
});
