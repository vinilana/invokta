import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  createEngineAccessTokenVerifier,
  EngineAccessTokenVerificationError,
} from "../src/identity/verifier.js";
import {
  createTestKeyMaterial,
  signTestToken,
  testAlgorithm,
  testAudience,
  testIssuer,
} from "./support/tokens.js";

type KeyMaterial = Awaited<ReturnType<typeof createTestKeyMaterial>>;

let keys: KeyMaterial;

beforeAll(async () => {
  keys = await createTestKeyMaterial();
});

function createVerifier(
  overrides: Partial<
    Parameters<typeof createEngineAccessTokenVerifier>[0]
  > = {},
) {
  return createEngineAccessTokenVerifier({
    resolveKey: keys.resolveKey,
    issuer: testIssuer,
    audience: testAudience,
    algorithms: [testAlgorithm],
    ...overrides,
  });
}

const signal = (): { readonly signal: AbortSignal } => ({
  signal: new AbortController().signal,
});

describe("app-issued engine access token verifier", () => {
  it("accepts a valid token and exposes only the enumerated claims", async () => {
    const token = await signTestToken(keys.signingKey, {
      email: "ada@example.test",
      name: "Ada Lovelace",
      scope: "engine:invoke engine:read",
    });

    await expect(createVerifier().verify(token, signal())).resolves.toEqual({
      subject: "user_2f1a",
      email: "ada@example.test",
      name: "Ada Lovelace",
      scopes: ["engine:invoke", "engine:read"],
    });
  });

  it("returns null for a malformed credential", async () => {
    const verifier = createVerifier();

    await expect(verifier.verify("", signal())).resolves.toBeNull();
    await expect(verifier.verify("not-a-jwt", signal())).resolves.toBeNull();
    await expect(verifier.verify("a.b.c", signal())).resolves.toBeNull();
    await expect(
      verifier.verify(`x${"y".repeat(8192)}`, signal()),
    ).resolves.toBeNull();
  });

  it("returns null for an expired token", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = await signTestToken(keys.signingKey, {
      issuedAt: nowSeconds - 3600,
      expiresAt: nowSeconds - 60,
    });

    await expect(createVerifier().verify(token, signal())).resolves.toBeNull();
  });

  it("returns null for the wrong issuer", async () => {
    const token = await signTestToken(keys.signingKey, {
      issuer: "https://attacker.example.test",
    });

    await expect(createVerifier().verify(token, signal())).resolves.toBeNull();
  });

  it("returns null for the wrong audience", async () => {
    const token = await signTestToken(keys.signingKey, {
      audience: "https://other-engine.example.test/mcp",
    });

    await expect(createVerifier().verify(token, signal())).resolves.toBeNull();
  });

  it("returns null for a signature made with a foreign key", async () => {
    const token = await signTestToken(keys.foreignSigningKey);

    await expect(createVerifier().verify(token, signal())).resolves.toBeNull();
  });

  it("returns null when no published key matches the token key id", async () => {
    const token = await signTestToken(keys.signingKey, {
      keyId: "rotated-out",
    });

    await expect(createVerifier().verify(token, signal())).resolves.toBeNull();
  });

  it("returns null when the token omits the subject claim", async () => {
    const token = await signTestToken(keys.signingKey, { subject: null });

    await expect(createVerifier().verify(token, signal())).resolves.toBeNull();
  });

  it("returns null when the token algorithm is not allowed", async () => {
    const token = await signTestToken(keys.signingKey);

    await expect(
      createVerifier({ algorithms: ["EdDSA"] }).verify(token, signal()),
    ).resolves.toBeNull();
  });

  it("throws a sanitized infrastructure error when key resolution fails", async () => {
    const token = await signTestToken(keys.signingKey);
    const resolveKey = vi.fn(() => {
      throw new Error("jwks endpoint unreachable at https://app.example.test");
    });

    const failure = await createVerifier({ resolveKey })
      .verify(token, signal())
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(EngineAccessTokenVerificationError);
    expect((failure as Error).message).toBe(
      "The engine access token could not be verified.",
    );
    expect((failure as Error).message).not.toContain("jwks endpoint");
  });

  it("throws an infrastructure error when its own deadline elapses", async () => {
    const token = await signTestToken(keys.signingKey);
    const resolveKey = vi.fn(
      async () => new Promise<never>(() => undefined),
    ) as unknown as typeof keys.resolveKey;

    await expect(
      createVerifier({ resolveKey, timeoutMs: 20 }).verify(token, signal()),
    ).rejects.toBeInstanceOf(EngineAccessTokenVerificationError);
  });

  it("throws an infrastructure error when the caller aborts the request", async () => {
    const token = await signTestToken(keys.signingKey);
    const controller = new AbortController();
    const resolveKey = vi.fn(
      async () => new Promise<never>(() => undefined),
    ) as unknown as typeof keys.resolveKey;

    const pending = createVerifier({ resolveKey }).verify(token, {
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(
      EngineAccessTokenVerificationError,
    );
  });

  it("never surfaces the raw token in the verification result", async () => {
    const token = await signTestToken(keys.signingKey, {
      email: "ada@example.test",
    });

    const verified = await createVerifier().verify(token, signal());

    expect(JSON.stringify(verified)).not.toContain(token);
    for (const segment of token.split(".")) {
      expect(JSON.stringify(verified)).not.toContain(segment);
    }
  });
});
