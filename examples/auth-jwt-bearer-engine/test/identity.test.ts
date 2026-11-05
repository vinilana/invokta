import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import {
  createJwtBearerAuthenticator,
  type JwtBearerAuthenticatorOptions,
  JwtVerificationUnavailableError,
} from "@invokta/auth-jwt";
import {
  exportJWK,
  generateKeyPair,
  type JSONWebKeySet,
  type JWK,
  SignJWT,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import { engine } from "../src/engine.js";
import {
  conventionalJwksUri,
  openIdConfigurationUrl,
  resolveJwksUri,
} from "../src/identity/jwks-location.js";
import { defaultSignatureAlgorithms } from "../src/mcp-http.js";

const issuer = "https://identity.example.com";
const audience = "https://engine.example.com/mcp";
const signingKeyId = "test-signing-key";
const otherKeyId = "test-rotated-key";

interface TestKeys {
  readonly signingKey: CryptoKey;
  readonly foreignKey: CryptoKey;
  readonly ellipticKey: CryptoKey;
  readonly jwks: JSONWebKeySet;
}

let keys: TestKeys;

function authenticationRequest(authorization?: string) {
  return {
    path: "/mcp",
    method: "POST",
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "authorization" ? (authorization ?? null) : null,
      has: (name: string) =>
        name.toLowerCase() === "authorization" && authorization !== undefined,
    },
    signal: new AbortController().signal,
  };
}

interface TokenOverrides {
  readonly issuer?: string;
  readonly audience?: string;
  readonly subject?: string | undefined;
  readonly scope?: string | undefined;
  readonly clientId?: string;
  readonly expiresIn?: string;
  readonly key?: CryptoKey;
  readonly algorithm?: string;
  readonly keyId?: string;
}

async function mintToken(overrides: TokenOverrides = {}): Promise<string> {
  const payload: Record<string, unknown> = {};
  if (overrides.scope !== undefined) payload.scope = overrides.scope;
  if (overrides.clientId !== undefined) payload.client_id = overrides.clientId;

  let jwt = new SignJWT(payload)
    .setProtectedHeader({
      alg: overrides.algorithm ?? "RS256",
      kid: overrides.keyId ?? signingKeyId,
      typ: "at+jwt",
    })
    .setIssuer(overrides.issuer ?? issuer)
    .setAudience(overrides.audience ?? audience)
    .setIssuedAt()
    .setExpirationTime(overrides.expiresIn ?? "5m");

  const subject = "subject" in overrides ? overrides.subject : "user-42";
  if (subject !== undefined) jwt = jwt.setSubject(subject);

  return jwt.sign(overrides.key ?? keys.signingKey);
}

beforeAll(async () => {
  const signing = await generateKeyPair("RS256", { extractable: true });
  const foreign = await generateKeyPair("RS256", { extractable: true });
  const elliptic = await generateKeyPair("ES256", { extractable: true });

  const signingJwk: JWK = {
    ...(await exportJWK(signing.publicKey)),
    kid: signingKeyId,
    alg: "RS256",
    use: "sig",
  };
  const ellipticJwk: JWK = {
    ...(await exportJWK(elliptic.publicKey)),
    kid: otherKeyId,
    alg: "ES256",
    use: "sig",
  };

  keys = {
    signingKey: signing.privateKey,
    foreignKey: foreign.privateKey,
    ellipticKey: elliptic.privateKey,
    jwks: { keys: [signingJwk, ellipticJwk] },
  };
});

/**
 * The example's authentication policy, with the local key set the tests
 * publish in place of the issuer's remote JWKS.
 */
function authenticator(overrides: Partial<JwtBearerAuthenticatorOptions> = {}) {
  return createJwtBearerAuthenticator({
    issuer,
    audience,
    algorithms: defaultSignatureAlgorithms,
    jwks: keys.jwks,
    ...overrides,
  } as JwtBearerAuthenticatorOptions);
}

describe("JWKS location", () => {
  it("derives the OpenID Provider configuration URL from the issuer", () => {
    expect(openIdConfigurationUrl("https://identity.example.com")).toBe(
      "https://identity.example.com/.well-known/openid-configuration",
    );
    expect(openIdConfigurationUrl("https://identity.example.com/tenant/")).toBe(
      "https://identity.example.com/tenant/.well-known/openid-configuration",
    );
  });

  it("derives the conventional JWKS URI and rejects an unusable issuer", () => {
    expect(conventionalJwksUri("https://identity.example.com/tenant")).toBe(
      "https://identity.example.com/tenant/.well-known/jwks.json",
    );
    expect(() => conventionalJwksUri("http://identity.example.com")).toThrow(
      /issuer/iu,
    );
    expect(() =>
      conventionalJwksUri("https://identity.example.com?tenant=a"),
    ).toThrow(/issuer/iu);
    expect(() => conventionalJwksUri("not-a-url")).toThrow(/issuer/iu);
  });

  it("prefers an explicit override, which the authenticator holds to HTTPS", () => {
    expect(resolveJwksUri(issuer, "https://keys.example.com/jwks.json")).toBe(
      "https://keys.example.com/jwks.json",
    );
    expect(resolveJwksUri(issuer)).toBe(
      "https://identity.example.com/.well-known/jwks.json",
    );
    expect(() =>
      createJwtBearerAuthenticator({
        issuer,
        audience,
        algorithms: defaultSignatureAlgorithms,
        jwksUrl: resolveJwksUri(issuer, "http://keys.internal:8080/jwks.json"),
      }),
    ).toThrow(/HTTPS/u);
  });
});

describe("authenticate hook", () => {
  it("returns the default principal for a valid credential", async () => {
    const token = await mintToken({
      scope: "engine:invoke reports:read",
      clientId: "reporting-cli",
    });

    await expect(
      authenticator()(authenticationRequest(`Bearer ${token}`)),
    ).resolves.toEqual({
      id: "user-42",
      attributes: {
        scopes: ["engine:invoke", "reports:read"],
        issuer,
        clientId: "reporting-cli",
      },
    });
  });

  it("keeps credential material out of the principal", async () => {
    const token = await mintToken({ scope: "engine:invoke" });

    const principal = await authenticator()(
      authenticationRequest(`Bearer ${token}`),
    );

    const serialized = JSON.stringify(principal);
    for (const segment of token.split(".")) {
      expect(serialized).not.toContain(segment);
    }
  });

  it.each([
    ["a missing header", async () => undefined],
    ["another scheme", async () => "Basic dXNlcjpwYXNz"],
    ["a malformed token", async () => "Bearer not-a-jwt"],
    [
      "an expired token",
      async () => `Bearer ${await mintToken({ expiresIn: "-1h" })}`,
    ],
    [
      "a token from another issuer",
      async () =>
        `Bearer ${await mintToken({ issuer: "https://attacker.example.com" })}`,
    ],
    [
      "a token for another audience",
      async () =>
        `Bearer ${await mintToken({ audience: "https://other.example.com/mcp" })}`,
    ],
    [
      "a token signed by an unknown key",
      async () =>
        `Bearer ${await mintToken({ key: keys.foreignKey, keyId: "unknown-key" })}`,
    ],
    [
      "a token whose signature does not verify",
      async () => `Bearer ${await mintToken({ key: keys.foreignKey })}`,
    ],
    [
      "a token without a subject claim",
      async () => `Bearer ${await mintToken({ subject: undefined })}`,
    ],
  ])("resolves null for %s", async (_label, authorization) => {
    await expect(
      authenticator()(authenticationRequest(await authorization())),
    ).resolves.toBeNull();
  });

  it("resolves null for an algorithm outside the configured allowlist", async () => {
    const token = await mintToken({
      key: keys.ellipticKey,
      algorithm: "ES256",
      keyId: otherKeyId,
    });

    await expect(
      authenticator({ algorithms: ["RS256"] })(
        authenticationRequest(`Bearer ${token}`),
      ),
    ).resolves.toBeNull();
    await expect(
      authenticator()(authenticationRequest(`Bearer ${token}`)),
    ).resolves.toMatchObject({ id: "user-42" });
  });

  it("resolves null for a token missing a required scope", async () => {
    const token = await mintToken({ scope: "reports:read" });

    await expect(
      authenticator({ requiredScopes: ["engine:invoke"] })(
        authenticationRequest(`Bearer ${token}`),
      ),
    ).resolves.toBeNull();
  });

  it("rejects when the issuer's key set cannot be fetched", async () => {
    const outage = createServer((_request, response) => {
      response.writeHead(503).end();
    });
    await new Promise<void>((resolve) =>
      outage.listen(0, "127.0.0.1", resolve),
    );
    const { port } = outage.address() as AddressInfo;

    try {
      const authenticate = createJwtBearerAuthenticator({
        issuer,
        audience,
        algorithms: defaultSignatureAlgorithms,
        jwksUrl: `http://127.0.0.1:${port}/.well-known/jwks.json`,
      });

      await expect(
        authenticate(authenticationRequest(`Bearer ${await mintToken()}`)),
      ).rejects.toBeInstanceOf(JwtVerificationUnavailableError);
    } finally {
      await new Promise<void>((resolve) => outage.close(() => resolve()));
    }
  });

  it("authenticates a caller that identity.whoami then echoes", async () => {
    const token = await mintToken({ scope: "engine:invoke" });
    const principal = await authenticator()(
      authenticationRequest(`Bearer ${token}`),
    );

    expect(principal).not.toBeNull();
    await expect(
      engine.invoke("identity.whoami", {}, { source: "mcp-http", principal }),
    ).resolves.toEqual({
      principalId: "user-42",
      attributes: { scopes: ["engine:invoke"], issuer },
    });
  });
});

describe("identity.whoami capability", () => {
  it("denies an unauthenticated invocation", async () => {
    await expect(
      engine.invoke("identity.whoami", {}, { source: "direct" }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("derives its result from the principal, never from input", async () => {
    await expect(
      engine.invoke("identity.whoami", {} as Record<string, never>, {
        source: "direct",
        principal: {
          id: "user-42",
          attributes: { scopes: ["engine:invoke"], issuer },
        },
      }),
    ).resolves.toEqual({
      principalId: "user-42",
      attributes: { scopes: ["engine:invoke"], issuer },
    });
  });
});
