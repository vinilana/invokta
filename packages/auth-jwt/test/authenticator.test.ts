import {
  exportJWK,
  type GenerateKeyPairResult,
  generateKeyPair,
  generateSecret,
  type JSONWebKeySet,
  SignJWT,
  UnsecuredJWT,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import {
  createJwtBearerAuthenticator,
  defaultJwtPrincipal,
  isJwtSignatureAlgorithm,
  type JwtBearerAuthenticatorOptions,
  JwtVerificationUnavailableError,
} from "../src/index.js";
import {
  bearerRequest,
  createTestKeys,
  mintToken,
  nowSeconds,
  type TestKeys,
  testAudience,
  testIssuer,
  validClaims,
} from "./support/tokens.js";

let keys: TestKeys;

beforeAll(async () => {
  keys = await createTestKeys();
});

function authenticator(overrides: Partial<JwtBearerAuthenticatorOptions> = {}) {
  return createJwtBearerAuthenticator({
    issuer: testIssuer,
    audience: testAudience,
    algorithms: ["RS256", "ES256"],
    jwks: keys.jwks,
    ...overrides,
  } as JwtBearerAuthenticatorOptions);
}

describe("valid credentials", () => {
  it("returns the default principal for a verified token", async () => {
    const token = await mintToken(keys);

    await expect(
      authenticator()(bearerRequest(`Bearer ${token}`)),
    ).resolves.toEqual({
      id: "user-42",
      attributes: {
        scopes: ["engine:invoke", "reports:read"],
        issuer: testIssuer,
        clientId: "reporting-cli",
      },
    });
  });

  it("accepts the authentication scheme case-insensitively", async () => {
    const token = await mintToken(keys);

    await expect(
      authenticator()(bearerRequest(`bearer ${token}`)),
    ).resolves.toMatchObject({ id: "user-42" });
    await expect(
      authenticator()(bearerRequest(`BEARER ${token}`)),
    ).resolves.toMatchObject({ id: "user-42" });
  });

  it("accepts every algorithm in the allowlist and an audience list", async () => {
    const token = await mintToken(keys, validClaims(), { algorithm: "ES256" });
    const authenticate = authenticator({
      audience: ["https://other.example.com/mcp", testAudience],
    });

    await expect(
      authenticate(bearerRequest(`Bearer ${token}`)),
    ).resolves.toMatchObject({ id: "user-42" });
  });

  it("works without a request signal", async () => {
    const token = await mintToken(keys);

    await expect(
      authenticator()({
        headers: { get: () => `Bearer ${token}` },
      }),
    ).resolves.toMatchObject({ id: "user-42" });
  });

  it("keeps every token segment out of the principal", async () => {
    const token = await mintToken(keys);

    const principal = await authenticator()(bearerRequest(`Bearer ${token}`));

    const serialized = JSON.stringify(principal);
    for (const segment of token.split(".")) {
      expect(serialized).not.toContain(segment);
    }
  });
});

describe("bearer credential parsing", () => {
  it.each([
    ["no Authorization header", undefined],
    ["an empty header", ""],
    ["another scheme", "Basic dXNlcjpwYXNz"],
    ["the scheme without a token", "Bearer"],
    ["the scheme and a space without a token", "Bearer "],
    ["two spaces after the scheme", "Bearer  a.b.c"],
    ["a tab after the scheme", "Bearer\ta.b.c"],
    ["leading whitespace", " Bearer a.b.c"],
    ["trailing whitespace", "Bearer a.b.c "],
    ["a token with two segments", "Bearer a.b"],
    ["a token with five segments", "Bearer a.b.c.d.e"],
    ["an empty signature segment", "Bearer a.b."],
    ["characters outside base64url", "Bearer a+b.c/d.e=f"],
    ["two credentials joined by a comma", "Bearer a.b.c, Bearer d.e.f"],
  ])("resolves null for %s", async (_label, authorization) => {
    await expect(
      authenticator()(bearerRequest(authorization)),
    ).resolves.toBeNull();
  });

  it("bounds the token length, inclusive of the configured maximum", async () => {
    const token = await mintToken(keys);

    await expect(
      authenticator({ maxTokenLength: token.length })(
        bearerRequest(`Bearer ${token}`),
      ),
    ).resolves.toMatchObject({ id: "user-42" });
    await expect(
      authenticator({ maxTokenLength: token.length - 1 })(
        bearerRequest(`Bearer ${token}`),
      ),
    ).resolves.toBeNull();
  });

  it("rejects an oversized header before verification", async () => {
    const oversized = `Bearer ${"a".repeat(9_000)}.b.c`;

    await expect(authenticator()(bearerRequest(oversized))).resolves.toBeNull();
  });
});

describe("invalid credentials", () => {
  it.each([
    [
      "an expired token",
      () => mintToken(keys, validClaims(), { expiresAt: nowSeconds() - 60 }),
    ],
    [
      "a token that is not yet valid",
      () => mintToken(keys, validClaims(), { notBefore: nowSeconds() + 600 }),
    ],
    [
      "a token without an expiry",
      () => mintToken(keys, validClaims(), { expiresAt: null }),
    ],
    [
      "another issuer",
      () =>
        mintToken(keys, validClaims({ iss: "https://attacker.example.com" })),
    ],
    [
      "an issuer that differs by a trailing slash",
      () => mintToken(keys, validClaims({ iss: `${testIssuer}/` })),
    ],
    [
      "another audience",
      () =>
        mintToken(keys, validClaims({ aud: "https://other.example.com/mcp" })),
    ],
    [
      "a missing audience",
      () => {
        const { aud: _aud, ...claims } = validClaims();
        return mintToken(keys, claims);
      },
    ],
    [
      "a missing subject",
      () => {
        const { sub: _sub, ...claims } = validClaims();
        return mintToken(keys, claims);
      },
    ],
    [
      "an unknown key identifier",
      () =>
        mintToken(keys, validClaims(), {
          key: keys.foreignPrivateKey,
          keyId: "unpublished-key",
        }),
    ],
    [
      "a signature from another key",
      () => mintToken(keys, validClaims(), { key: keys.foreignPrivateKey }),
    ],
    ["a structurally valid but meaningless token", async () => "a.b.c"],
  ])("resolves null for %s", async (_label, mint) => {
    const token = await mint();

    await expect(
      authenticator()(bearerRequest(`Bearer ${token}`)),
    ).resolves.toBeNull();
  });

  it("resolves null for an algorithm outside the allowlist", async () => {
    const token = await mintToken(keys, validClaims(), { algorithm: "ES256" });

    await expect(
      authenticator({ algorithms: ["RS256"] })(
        bearerRequest(`Bearer ${token}`),
      ),
    ).resolves.toBeNull();
  });

  it("resolves null for a shared-secret token", async () => {
    const secret = await generateSecret("HS256", { extractable: true });
    const token = await new SignJWT(validClaims())
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(secret);

    await expect(
      authenticator()(bearerRequest(`Bearer ${token}`)),
    ).resolves.toBeNull();
  });

  it("resolves null for an unsecured token and for alg none with a forged signature", async () => {
    const unsecured = new UnsecuredJWT(validClaims())
      .setIssuedAt()
      .setExpirationTime("5m")
      .encode();
    const [header, payload] = unsecured.split(".");

    await expect(
      authenticator()(bearerRequest(`Bearer ${unsecured}`)),
    ).resolves.toBeNull();
    await expect(
      authenticator()(bearerRequest(`Bearer ${header}.${payload}.Zm9yZ2Vk`)),
    ).resolves.toBeNull();
  });

  it("honors a bounded clock tolerance", async () => {
    const token = await mintToken(keys, validClaims(), {
      expiresAt: nowSeconds() - 10,
    });

    await expect(
      authenticator()(bearerRequest(`Bearer ${token}`)),
    ).resolves.toBeNull();
    await expect(
      authenticator({ clockToleranceSeconds: 60 })(
        bearerRequest(`Bearer ${token}`),
      ),
    ).resolves.toMatchObject({ id: "user-42" });
  });
});

describe("required scopes", () => {
  it("returns the principal when every required scope is granted", async () => {
    const token = await mintToken(keys);

    await expect(
      authenticator({ requiredScopes: ["engine:invoke", "reports:read"] })(
        bearerRequest(`Bearer ${token}`),
      ),
    ).resolves.toMatchObject({ id: "user-42" });
  });

  it.each([
    ["a missing scope", validClaims({ scope: "reports:read" })],
    ["no scope claim", validClaims({ scope: undefined })],
    [
      "a scope claim that is not a string",
      validClaims({ scope: ["engine:invoke"] }),
    ],
    [
      "a scope that only shares a prefix",
      validClaims({ scope: "engine:invoke-all" }),
    ],
  ])("resolves null for %s", async (_label, claims) => {
    const token = await mintToken(keys, claims);

    await expect(
      authenticator({ requiredScopes: ["engine:invoke"] })(
        bearerRequest(`Bearer ${token}`),
      ),
    ).resolves.toBeNull();
  });
});

describe("principal mapping", () => {
  it("maps only sub, scope, iss, and client_id by default", () => {
    const principal = defaultJwtPrincipal({
      ...validClaims({ scope: "a  b a" }),
      email: "person@example.com",
      nested: { secret: true },
    });

    expect(principal).toEqual({
      id: "user-42",
      attributes: {
        scopes: ["a", "b"],
        issuer: testIssuer,
        clientId: "reporting-cli",
      },
    });
    expect(Object.isFrozen(principal)).toBe(true);
    expect(Object.isFrozen(principal?.attributes)).toBe(true);
    expect(JSON.stringify(principal)).not.toContain("person@example.com");
  });

  it("omits an unusable client_id and refuses an unusable subject", () => {
    expect(
      defaultJwtPrincipal(validClaims({ client_id: 7 }))?.attributes,
    ).not.toHaveProperty("clientId");
    expect(defaultJwtPrincipal(validClaims({ sub: "   " }))).toBeNull();
    expect(defaultJwtPrincipal(validClaims({ iss: "" }))).toBeNull();
    expect(structuredClone(defaultJwtPrincipal(validClaims()))).toEqual(
      defaultJwtPrincipal(validClaims()),
    );
  });

  it("passes only the verified claims to a custom mapper", async () => {
    const token = await mintToken(
      keys,
      validClaims({ permissions: ["orders:read"] }),
    );
    const received: unknown[] = [];
    const authenticate = authenticator({
      principal: (...args) => {
        received.push(...args);
        return {
          id: `tenant:${String(args[0].sub)}`,
          attributes: { permissions: args[0].permissions },
        };
      },
    });

    await expect(
      authenticate(bearerRequest(`Bearer ${token}`)),
    ).resolves.toEqual({
      id: "tenant:user-42",
      attributes: { permissions: ["orders:read"] },
    });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ iss: testIssuer, aud: testAudience });
    expect(JSON.stringify(received)).not.toContain(token);
  });

  it.each([
    ["null", null],
    ["an empty id", { id: "" }],
    ["a non-string id", { id: 42 }],
    ["array attributes", { id: "user-42", attributes: ["x"] }],
    ["a non-object", "user-42"],
  ])("resolves null when the mapper returns %s", async (_label, result) => {
    const token = await mintToken(keys);
    const authenticate = authenticator({
      principal: () => result as never,
    });

    await expect(
      authenticate(bearerRequest(`Bearer ${token}`)),
    ).resolves.toBeNull();
  });

  it("propagates an error thrown by the host mapper", async () => {
    const token = await mintToken(keys);
    const failure = new Error("host mapping failed");
    const authenticate = authenticator({
      principal: () => {
        throw failure;
      },
    });

    await expect(authenticate(bearerRequest(`Bearer ${token}`))).rejects.toBe(
      failure,
    );
  });
});

async function rotationKeySet(count: number) {
  const pairs: GenerateKeyPairResult[] = [];
  for (let index = 0; index < count; index += 1) {
    pairs.push(await generateKeyPair("RS256", { extractable: true }));
  }
  const jwks: JSONWebKeySet = {
    keys: await Promise.all(
      pairs.map(async ({ publicKey }) => ({
        ...(await exportJWK(publicKey)),
        alg: "RS256",
        use: "sig",
      })),
    ),
  };
  return {
    jwks,
    privateKeys: pairs.map(({ privateKey }) => privateKey),
    privateKey(index: number): CryptoKey {
      const pair = pairs[index];
      if (pair === undefined) throw new RangeError("No such rotation key.");
      return pair.privateKey;
    },
  };
}

/** A token whose header carries no `kid` and whose signature is garbage. */
const forgedWithoutKeyId = `${Buffer.from(
  JSON.stringify({ alg: "RS256" }),
).toString("base64url")}.${Buffer.from(JSON.stringify(validClaims())).toString(
  "base64url",
)}.AAAA`;

describe("tokens without a key identifier", () => {
  it("verifies against whichever of several matching keys signed it", async () => {
    const rotation = await rotationKeySet(2);
    const authenticate = authenticator({ jwks: rotation.jwks });

    for (const privateKey of rotation.privateKeys) {
      const token = await mintToken(keys, validClaims(), {
        key: privateKey,
        keyId: null,
      });
      await expect(
        authenticate(bearerRequest(`Bearer ${token}`)),
      ).resolves.toMatchObject({ id: "user-42" });
    }
  });

  it("resolves null for a forged token when several keys match", async () => {
    const rotation = await rotationKeySet(2);
    const authenticate = authenticator({ jwks: rotation.jwks });
    const foreign = await mintToken(keys, validClaims(), {
      key: keys.foreignPrivateKey,
      keyId: null,
    });

    await expect(
      authenticate(bearerRequest(`Bearer ${forgedWithoutKeyId}`)),
    ).resolves.toBeNull();
    await expect(
      authenticate(bearerRequest(`Bearer ${foreign}`)),
    ).resolves.toBeNull();
  });

  it("resolves null for a correctly signed but expired token among several keys", async () => {
    const rotation = await rotationKeySet(2);
    const token = await mintToken(keys, validClaims(), {
      key: rotation.privateKey(1),
      keyId: null,
      expiresAt: nowSeconds() - 60,
    });

    await expect(
      authenticator({ jwks: rotation.jwks })(bearerRequest(`Bearer ${token}`)),
    ).resolves.toBeNull();
  });

  it("tries at most eight candidate keys", async () => {
    const rotation = await rotationKeySet(9);
    const authenticate = authenticator({ jwks: rotation.jwks });
    const eighth = await mintToken(keys, validClaims(), {
      key: rotation.privateKey(7),
      keyId: null,
    });
    const ninth = await mintToken(keys, validClaims(), {
      key: rotation.privateKey(8),
      keyId: null,
    });

    await expect(
      authenticate(bearerRequest(`Bearer ${eighth}`)),
    ).resolves.toMatchObject({ id: "user-42" });
    await expect(
      authenticate(bearerRequest(`Bearer ${ninth}`)),
    ).resolves.toBeNull();
  });
});

describe("verification that cannot complete", () => {
  it("rejects when the request is already aborted", async () => {
    const token = await mintToken(keys);
    const controller = new AbortController();
    controller.abort();

    await expect(
      authenticator()(bearerRequest(`Bearer ${token}`, controller.signal)),
    ).rejects.toBeInstanceOf(JwtVerificationUnavailableError);
  });
});

describe("configuration", () => {
  const base = (): Record<string, unknown> => ({
    issuer: testIssuer,
    audience: testAudience,
    algorithms: ["RS256"],
    jwks: keys.jwks,
  });

  it.each([
    ["a missing issuer", { issuer: undefined }],
    ["an empty issuer", { issuer: "" }],
    ["an issuer with surrounding whitespace", { issuer: ` ${testIssuer}` }],
    ["a missing audience", { audience: undefined }],
    ["an empty audience", { audience: "" }],
    ["an empty audience list", { audience: [] }],
    ["an audience list with an empty entry", { audience: [testAudience, ""] }],
    ["missing algorithms", { algorithms: undefined }],
    ["an empty algorithm list", { algorithms: [] }],
    ["alg none", { algorithms: ["none"] }],
    ["a shared-secret algorithm", { algorithms: ["HS256"] }],
    ["an unknown algorithm", { algorithms: ["RS265"] }],
    ["a duplicate algorithm", { algorithms: ["RS256", "RS256"] }],
    ["a negative clock tolerance", { clockToleranceSeconds: -1 }],
    ["a fractional clock tolerance", { clockToleranceSeconds: 1.5 }],
    ["a clock tolerance above 300 seconds", { clockToleranceSeconds: 301 }],
    ["an empty required scope list", { requiredScopes: [] }],
    ["a required scope with a space", { requiredScopes: ["a b"] }],
    ["a duplicate required scope", { requiredScopes: ["a", "a"] }],
    ["a zero token length", { maxTokenLength: 0 }],
    ["a token length above 16384", { maxTokenLength: 16_385 }],
    ["a non-function mapper", { principal: "sub" }],
    ["no key source", { jwks: undefined }],
    ["two key sources", { jwksUrl: "https://identity.example.com/jwks" }],
    ["a malformed key set", { jwks: { keys: "none" } }],
    [
      "a key set with private key material",
      { jwks: { keys: [{ kty: "oct", k: "c2VjcmV0" }] } },
    ],
  ])("rejects %s with a TypeError", (_label, override) => {
    expect(() =>
      createJwtBearerAuthenticator({
        ...base(),
        ...override,
      } as unknown as JwtBearerAuthenticatorOptions),
    ).toThrow(TypeError);
  });

  it.each([
    ["plain HTTP off loopback", "http://identity.example.com/jwks"],
    ["embedded credentials", "https://user:pass@identity.example.com/jwks"],
    ["a fragment", "https://identity.example.com/jwks#keys"],
    ["a relative URL", "/jwks"],
    ["a non-HTTP scheme", "file:///etc/jwks.json"],
  ])("rejects a JWKS URL with %s", (_label, jwksUrl) => {
    expect(() =>
      createJwtBearerAuthenticator({
        issuer: testIssuer,
        audience: testAudience,
        algorithms: ["RS256"],
        jwksUrl,
      }),
    ).toThrow(TypeError);
  });

  it("never echoes a configured value in a configuration error", () => {
    const secretLookingValue = "https://user:s3cr3t@identity.example.com/jwks";

    expect(() =>
      createJwtBearerAuthenticator({
        issuer: testIssuer,
        audience: testAudience,
        algorithms: ["RS256"],
        jwksUrl: secretLookingValue,
      }),
    ).toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining("s3cr3t"),
      }),
    );
  });

  it("accepts HTTPS and loopback HTTP JWKS URLs without network access", () => {
    for (const jwksUrl of [
      "https://identity.example.com/.well-known/jwks.json",
      new URL("https://identity.example.com/keys?tenant=a"),
      "http://127.0.0.1:8080/jwks.json",
      "http://localhost:8080/jwks.json",
      "http://[::1]:8080/jwks.json",
    ]) {
      expect(() =>
        createJwtBearerAuthenticator({
          issuer: testIssuer,
          audience: testAudience,
          algorithms: ["RS256"],
          jwksUrl,
        }),
      ).not.toThrow();
    }
  });

  it("snapshots its configuration", async () => {
    const algorithms: string[] = ["RS256"];
    const requiredScopes = ["engine:invoke"];
    const jwks = structuredClone(keys.jwks);
    const authenticate = createJwtBearerAuthenticator({
      issuer: testIssuer,
      audience: testAudience,
      algorithms: algorithms as ["RS256"],
      requiredScopes,
      jwks,
    });
    algorithms.push("ES256");
    requiredScopes.push("admin");
    jwks.keys.length = 0;

    const rsa = await mintToken(keys);
    const elliptic = await mintToken(keys, validClaims(), {
      algorithm: "ES256",
    });

    await expect(
      authenticate(bearerRequest(`Bearer ${rsa}`)),
    ).resolves.toMatchObject({ id: "user-42" });
    await expect(
      authenticate(bearerRequest(`Bearer ${elliptic}`)),
    ).resolves.toBeNull();
  });

  it("recognizes the supported signature algorithms", () => {
    for (const algorithm of [
      "RS256",
      "RS384",
      "RS512",
      "PS256",
      "PS384",
      "PS512",
      "ES256",
      "ES384",
      "ES512",
      "EdDSA",
      "Ed25519",
    ]) {
      expect(isJwtSignatureAlgorithm(algorithm)).toBe(true);
    }
    for (const value of ["none", "HS256", "rs256", "", 256, undefined]) {
      expect(isJwtSignatureAlgorithm(value)).toBe(false);
    }
  });
});
