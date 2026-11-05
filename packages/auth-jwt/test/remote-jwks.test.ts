import { exportJWK, generateKeyPair, type JSONWebKeySet } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createJwtBearerAuthenticator,
  JwtVerificationUnavailableError,
} from "../src/index.js";
import { type JwksServer, startJwksServer } from "./support/jwks-server.js";
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
const servers: JwksServer[] = [];

beforeAll(async () => {
  keys = await createTestKeys();
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function jwksServer(
  behavior: Parameters<typeof startJwksServer>[0],
): Promise<JwksServer> {
  const server = await startJwksServer(behavior);
  servers.push(server);
  return server;
}

function remoteAuthenticator(server: JwksServer) {
  return createJwtBearerAuthenticator({
    issuer: testIssuer,
    audience: testAudience,
    algorithms: ["RS256"],
    jwksUrl: server.url,
  });
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("remote JWKS key source", () => {
  it("performs no network access until a credential arrives", async () => {
    const server = await jwksServer({ kind: "serve", jwks: keys.jwks });
    const authenticate = remoteAuthenticator(server);

    await expect(authenticate(bearerRequest(undefined))).resolves.toBeNull();
    await expect(
      authenticate(bearerRequest("Bearer not-a-jwt")),
    ).resolves.toBeNull();
    expect(server.requests()).toBe(0);
  });

  it("verifies against the fetched key set and reuses its cache", async () => {
    const server = await jwksServer({ kind: "serve", jwks: keys.jwks });
    const authenticate = remoteAuthenticator(server);
    const token = await mintToken(keys);

    await expect(
      authenticate(bearerRequest(`Bearer ${token}`)),
    ).resolves.toMatchObject({ id: "user-42" });
    await expect(
      authenticate(bearerRequest(`Bearer ${token}`)),
    ).resolves.toMatchObject({ id: "user-42" });
    expect(server.requests()).toBe(1);
  });

  it("answers an unknown key without refetching inside the cooldown", async () => {
    const server = await jwksServer({ kind: "serve", jwks: keys.jwks });
    const authenticate = remoteAuthenticator(server);
    const valid = await mintToken(keys);
    const unknown = await mintToken(keys, validClaims(), {
      key: keys.foreignPrivateKey,
      keyId: "rotated-away",
    });

    await authenticate(bearerRequest(`Bearer ${valid}`));
    await expect(
      authenticate(bearerRequest(`Bearer ${unknown}`)),
    ).resolves.toBeNull();
    await expect(
      authenticate(bearerRequest(`Bearer ${unknown}`)),
    ).resolves.toBeNull();
    expect(server.requests()).toBe(1);
  });

  it.each([
    ["an error status", { kind: "status", status: 503 } as const],
    ["a redirect", { kind: "status", status: 302 } as const],
    ["a malformed body", { kind: "malformed" } as const],
    ["a reset connection", { kind: "reset" } as const],
  ])(
    "rejects with a fixed error when the key set returns %s",
    async (_label, behavior) => {
      const server = await jwksServer(behavior);
      const token = await mintToken(keys);

      const failure = await failureOf(
        remoteAuthenticator(server)(bearerRequest(`Bearer ${token}`)),
      );

      expect(failure).toBeInstanceOf(JwtVerificationUnavailableError);
      const error = failure as Error;
      expect(error.message).toBe("JWT bearer verification is unavailable.");
      expect(error.cause).toBeUndefined();
      expect(String(error.stack)).not.toContain(server.url.host);
      expect(String(error.stack)).not.toContain(token);
    },
  );

  it("stops waiting for a slow key set when the request is aborted", async () => {
    const server = await jwksServer({ kind: "hang" });
    const token = await mintToken(keys);
    const controller = new AbortController();
    const started = Date.now();

    const pending = remoteAuthenticator(server)(
      bearerRequest(`Bearer ${token}`, controller.signal),
    );
    setTimeout(() => controller.abort(), 50);

    await expect(pending).rejects.toBeInstanceOf(
      JwtVerificationUnavailableError,
    );
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("remote JWKS tokens without a key identifier", () => {
  it("answers a forged token with null when the issuer publishes two keys", async () => {
    const current = await generateKeyPair("RS256", { extractable: true });
    const next = await generateKeyPair("RS256", { extractable: true });
    const rotation: JSONWebKeySet = {
      keys: [
        { ...(await exportJWK(current.publicKey)), alg: "RS256", use: "sig" },
        { ...(await exportJWK(next.publicKey)), alg: "RS256", use: "sig" },
      ],
    };
    const server = await jwksServer({ kind: "serve", jwks: rotation });
    const authenticate = remoteAuthenticator(server);
    const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString(
      "base64url",
    );
    const payload = Buffer.from(JSON.stringify(validClaims())).toString(
      "base64url",
    );
    const legitimate = await mintToken(keys, validClaims(), {
      key: next.privateKey,
      keyId: null,
    });

    await expect(
      authenticate(bearerRequest(`Bearer ${header}.${payload}.AAAA`)),
    ).resolves.toBeNull();
    await expect(
      authenticate(bearerRequest(`Bearer ${legitimate}`)),
    ).resolves.toMatchObject({ id: "user-42" });
    expect(server.requests()).toBe(1);
  });
});

describe("remote JWKS failure cooldown", () => {
  /** Fakes only the clock, so loopback HTTP and jose's timeout stay real. */
  function freezeClock(): (milliseconds: number) => void {
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start);
    return (milliseconds) => vi.setSystemTime(start + milliseconds);
  }

  async function longLivedToken(
    overrides: Parameters<typeof mintToken>[2] = {},
  ): Promise<string> {
    return mintToken(keys, validClaims(), {
      expiresAt: nowSeconds() + 3_600,
      ...overrides,
    });
  }

  it("does not refetch a failing key set for five seconds", async () => {
    const server = await jwksServer({ kind: "status", status: 503 });
    const authenticate = remoteAuthenticator(server);
    const token = await longLivedToken();
    const advanceTo = freezeClock();

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(
        authenticate(bearerRequest(`Bearer ${token}`)),
      ).rejects.toBeInstanceOf(JwtVerificationUnavailableError);
    }
    expect(server.requests()).toBe(1);

    server.setBehavior({ kind: "serve", jwks: keys.jwks });
    advanceTo(4_999);
    await expect(
      authenticate(bearerRequest(`Bearer ${token}`)),
    ).rejects.toBeInstanceOf(JwtVerificationUnavailableError);
    expect(server.requests()).toBe(1);

    advanceTo(5_000);
    await expect(
      authenticate(bearerRequest(`Bearer ${token}`)),
    ).resolves.toMatchObject({ id: "user-42" });
    expect(server.requests()).toBe(2);
  });

  it("keeps answering from a fresh cache while refetches fail", async () => {
    const server = await jwksServer({ kind: "serve", jwks: keys.jwks });
    const authenticate = remoteAuthenticator(server);
    const valid = await longLivedToken();
    const unknown = await longLivedToken({
      key: keys.foreignPrivateKey,
      keyId: "rotated-in",
    });
    const advanceTo = freezeClock();

    await authenticate(bearerRequest(`Bearer ${valid}`));
    server.setBehavior({ kind: "status", status: 503 });
    // Past jose's 30-second unknown-key cooldown, inside its 10-minute cache.
    advanceTo(31_000);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        authenticate(bearerRequest(`Bearer ${unknown}`)),
      ).resolves.toBeNull();
    }
    await expect(
      authenticate(bearerRequest(`Bearer ${valid}`)),
    ).resolves.toMatchObject({ id: "user-42" });
    expect(server.requests()).toBe(2);

    advanceTo(36_000);
    await expect(
      authenticate(bearerRequest(`Bearer ${unknown}`)),
    ).resolves.toBeNull();
    expect(server.requests()).toBe(3);
  });

  it("fails fast once the cache has expired and the key set is failing", async () => {
    const server = await jwksServer({ kind: "serve", jwks: keys.jwks });
    const authenticate = remoteAuthenticator(server);
    const token = await longLivedToken();
    const advanceTo = freezeClock();

    await authenticate(bearerRequest(`Bearer ${token}`));
    server.setBehavior({ kind: "status", status: 503 });
    advanceTo(600_001);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(
        authenticate(bearerRequest(`Bearer ${token}`)),
      ).rejects.toBeInstanceOf(JwtVerificationUnavailableError);
    }
    expect(server.requests()).toBe(2);
  });
});
