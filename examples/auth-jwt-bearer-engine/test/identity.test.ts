import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTVerifyGetKey,
  SignJWT,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import { engine } from "../src/engine.js";
import { parseScopeClaim, toPrincipal } from "../src/identity/principal.js";
import {
  conventionalJwksUri,
  createAccessTokenVerifier,
  openIdConfigurationUrl,
  resolveJwksUri,
} from "../src/identity/verifier.js";
import {
  createJwtBearerAuthenticate,
  readBearerToken,
} from "../src/mcp-http.js";

const issuer = "https://identity.example.com";
const audience = "https://engine.example.com/mcp";
const signingKeyId = "test-signing-key";
const otherKeyId = "test-rotated-key";

interface TestKeys {
  readonly signingKey: CryptoKey;
  readonly foreignKey: CryptoKey;
  readonly ellipticKey: CryptoKey;
  readonly getKey: JWTVerifyGetKey;
}

let keys: TestKeys;

function headerView(headers: Readonly<Record<string, string>>) {
  return {
    get: (name: string) => headers[name.toLowerCase()] ?? null,
    has: (name: string) => headers[name.toLowerCase()] !== undefined,
  };
}

function authenticationRequest(headers: Readonly<Record<string, string>>) {
  return {
    path: "/mcp",
    method: "POST",
    headers: headerView(headers),
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
    getKey: createLocalJWKSet({ keys: [signingJwk, ellipticJwk] }),
  };
});

function verifier(getKey: JWTVerifyGetKey = keys.getKey) {
  return createAccessTokenVerifier({ issuer, audience, getKey });
}

function freshSignal(): AbortSignal {
  return new AbortController().signal;
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

  it("holds the JWKS override to the same HTTPS-or-loopback rule as the issuer", () => {
    expect(resolveJwksUri(issuer, "https://keys.example.com/jwks.json")).toBe(
      "https://keys.example.com/jwks.json",
    );
    expect(resolveJwksUri(issuer, "http://127.0.0.1:8080/jwks.json")).toBe(
      "http://127.0.0.1:8080/jwks.json",
    );
    expect(resolveJwksUri(issuer)).toBe(
      "https://identity.example.com/.well-known/jwks.json",
    );
    expect(() =>
      resolveJwksUri(issuer, "http://keys.internal:8080/jwks.json"),
    ).toThrow(/HTTPS/u);
    expect(() => resolveJwksUri(issuer, "not-a-url")).toThrow(/JWKS/u);
  });
});

describe("claims to principal mapping", () => {
  it("parses a space-delimited scope claim into a unique string array", () => {
    expect(
      parseScopeClaim("engine:invoke  reports:read engine:invoke"),
    ).toEqual(["engine:invoke", "reports:read"]);
    expect(parseScopeClaim(undefined)).toEqual([]);
    expect(parseScopeClaim(["engine:invoke"])).toEqual([]);
  });

  it("maps only enumerated safe claims", () => {
    const principal = toPrincipal({
      sub: "user-42",
      iss: issuer,
      aud: audience,
      scope: "engine:invoke",
      client_id: "reporting-cli",
      email: "person@example.com",
      unknown_claim: { nested: true },
    });

    expect(principal).toEqual({
      id: "user-42",
      attributes: {
        scopes: ["engine:invoke"],
        issuer,
        clientId: "reporting-cli",
      },
    });
    expect(JSON.stringify(principal)).not.toContain("person@example.com");
    expect(JSON.stringify(principal)).not.toContain("unknown_claim");
  });

  it("returns null when the subject or issuer claim is unusable", () => {
    expect(toPrincipal({ iss: issuer })).toBeNull();
    expect(toPrincipal({ sub: "   ", iss: issuer })).toBeNull();
    expect(toPrincipal({ sub: "user-42" })).toBeNull();
  });

  it("produces a structured-cloneable principal", () => {
    const principal = toPrincipal({ sub: "user-42", iss: issuer });

    expect(principal).not.toBeNull();
    expect(structuredClone(principal)).toEqual(principal);
  });
});

describe("access token verifier", () => {
  it("returns a principal for a valid credential", async () => {
    const token = await mintToken({
      scope: "engine:invoke reports:read",
      clientId: "reporting-cli",
    });

    const principal = await verifier().verify(token, {
      signal: freshSignal(),
    });

    expect(principal).toEqual({
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

    const principal = await verifier().verify(token, {
      signal: freshSignal(),
    });

    const serialized = JSON.stringify(principal);
    expect(serialized).not.toContain(token);
    for (const segment of token.split(".")) {
      expect(serialized).not.toContain(segment);
    }
  });

  it.each([
    ["a malformed token", async () => "not-a-jwt"],
    ["an empty token", async () => ""],
    ["an expired token", async () => mintToken({ expiresIn: "-1h" })],
    [
      "a token from another issuer",
      async () => mintToken({ issuer: "https://attacker.example.com" }),
    ],
    [
      "a token for another audience",
      async () => mintToken({ audience: "https://other.example.com/mcp" }),
    ],
    [
      "a token signed by an unknown key",
      async () => mintToken({ key: keys.foreignKey, keyId: "unknown-key" }),
    ],
    [
      "a token whose signature does not verify",
      async () => mintToken({ key: keys.foreignKey }),
    ],
    [
      "a token without a subject claim",
      async () => mintToken({ subject: undefined }),
    ],
  ])("resolves null for %s", async (_label, mint) => {
    const token = await mint();

    await expect(
      verifier().verify(token, { signal: freshSignal() }),
    ).resolves.toBeNull();
  });

  it("resolves null for an algorithm outside the allowlist", async () => {
    const restricted = createAccessTokenVerifier({
      issuer,
      audience,
      getKey: keys.getKey,
      algorithms: ["RS256"],
    });
    const token = await mintToken({
      key: keys.ellipticKey,
      algorithm: "ES256",
      keyId: otherKeyId,
    });

    await expect(
      restricted.verify(token, { signal: freshSignal() }),
    ).resolves.toBeNull();
    await expect(
      verifier().verify(token, { signal: freshSignal() }),
    ).resolves.toMatchObject({ id: "user-42" });
  });

  it("rejects when the key set is ambiguous for the token", async () => {
    const first = await generateKeyPair("RS256", { extractable: true });
    const second = await generateKeyPair("RS256", { extractable: true });
    const ambiguous = createLocalJWKSet({
      keys: [
        { ...(await exportJWK(first.publicKey)), alg: "RS256", use: "sig" },
        { ...(await exportJWK(second.publicKey)), alg: "RS256", use: "sig" },
      ],
    });
    // No kid in the header, two same-algorithm keys in the set: jose cannot
    // pick a candidate, which is the issuer's publication problem.
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", typ: "at+jwt" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject("user-42")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(first.privateKey);

    await expect(
      verifier(ambiguous).verify(token, { signal: freshSignal() }),
    ).rejects.toThrow(/unavailable/iu);
  });

  it("rejects when the key source cannot complete the check", async () => {
    const unavailable: JWTVerifyGetKey = () => {
      throw new Error("jwks_uri fetch failed for https://identity.example.com");
    };
    const token = await mintToken();

    const failure = await verifier(unavailable)
      .verify(token, { signal: freshSignal() })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).name).toBe(
      "AccessTokenVerificationUnavailableError",
    );
    expect((failure as Error).message).not.toContain("jwks_uri");
  });

  it("rejects when the request is aborted before or during verification", async () => {
    const token = await mintToken();
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();

    await expect(
      verifier().verify(token, { signal: alreadyAborted.signal }),
    ).rejects.toThrow(/unavailable/iu);

    const pending = new AbortController();
    const slow: JWTVerifyGetKey = () => new Promise(() => undefined);
    const verification = verifier(slow).verify(token, {
      signal: pending.signal,
    });
    pending.abort();

    await expect(verification).rejects.toThrow(/unavailable/iu);
  });
});

describe("bearer credential parsing", () => {
  it.each([
    ["Bearer abc.def.ghi", "abc.def.ghi"],
    ["bearer abc.def.ghi", "abc.def.ghi"],
  ])("reads the token from %s", (header, expected) => {
    expect(readBearerToken(headerView({ authorization: header }))).toBe(
      expected,
    );
  });

  it.each([
    ["no authorization header", {}],
    ["an empty header", { authorization: "" }],
    ["another scheme", { authorization: "Basic dXNlcjpwYXNz" }],
    ["a scheme without a token", { authorization: "Bearer" }],
    ["a token containing whitespace", { authorization: "Bearer a b" }],
  ])("returns null for %s", (_label, headers) => {
    expect(readBearerToken(headerView(headers))).toBeNull();
  });
});

describe("authenticate hook", () => {
  it("authenticates a valid credential and answers identity.whoami", async () => {
    const token = await mintToken({ scope: "engine:invoke" });
    const authenticate = createJwtBearerAuthenticate(verifier());

    const principal = await authenticate(
      authenticationRequest({ authorization: `Bearer ${token}` }),
    );

    expect(principal).not.toBeNull();
    await expect(
      engine.invoke("identity.whoami", {}, { source: "mcp-http", principal }),
    ).resolves.toEqual({
      principalId: "user-42",
      attributes: { scopes: ["engine:invoke"], issuer },
    });
  });

  it("resolves null for a missing credential without calling the verifier", async () => {
    let calls = 0;
    const authenticate = createJwtBearerAuthenticate({
      verify: async () => {
        calls += 1;
        return null;
      },
    });

    await expect(authenticate(authenticationRequest({}))).resolves.toBeNull();
    expect(calls).toBe(0);
  });

  it("propagates a verifier infrastructure failure", async () => {
    const authenticate = createJwtBearerAuthenticate({
      verify: async () => {
        throw new Error("unavailable");
      },
    });

    await expect(
      authenticate(authenticationRequest({ authorization: "Bearer abc" })),
    ).rejects.toThrow();
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
