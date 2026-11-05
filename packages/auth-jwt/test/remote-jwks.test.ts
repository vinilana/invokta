import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  createJwtBearerAuthenticator,
  JwtVerificationUnavailableError,
} from "../src/index.js";
import { type JwksServer, startJwksServer } from "./support/jwks-server.js";
import {
  bearerRequest,
  createTestKeys,
  mintToken,
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

  it("recovers once the key set is reachable again", async () => {
    const server = await jwksServer({ kind: "status", status: 503 });
    const authenticate = remoteAuthenticator(server);
    const token = await mintToken(keys);

    await expect(
      authenticate(bearerRequest(`Bearer ${token}`)),
    ).rejects.toBeInstanceOf(JwtVerificationUnavailableError);
    server.setBehavior({ kind: "serve", jwks: keys.jwks });

    await expect(
      authenticate(bearerRequest(`Bearer ${token}`)),
    ).resolves.toMatchObject({ id: "user-42" });
  });

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
