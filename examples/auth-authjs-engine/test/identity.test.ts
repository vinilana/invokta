import { beforeAll, describe, expect, it } from "vitest";

import { issueEngineAccessToken } from "../src/identity/issuer.js";
import {
  accessTokenToPrincipal,
  sessionToPrincipal,
} from "../src/identity/principal.js";
import { createEngineAccessTokenVerifier } from "../src/identity/verifier.js";
import {
  createTestKeyMaterial,
  createTestSession,
  testAlgorithm,
  testAudience,
  testIssuer,
  testKeyId,
} from "./support/tokens.js";

type KeyMaterial = Awaited<ReturnType<typeof createTestKeyMaterial>>;

let keys: KeyMaterial;

beforeAll(async () => {
  keys = await createTestKeyMaterial();
});

describe("Auth.js session to principal mapping", () => {
  it("maps a resolved session to a principal with enumerated safe fields", () => {
    expect(sessionToPrincipal(createTestSession())).toEqual({
      id: "user_2f1a",
      attributes: {
        channel: "authjs-session",
        email: "ada@example.test",
        name: "Ada Lovelace",
      },
    });
  });

  it("omits fields that are not authorization relevant", () => {
    const principal = sessionToPrincipal(createTestSession());

    expect(principal?.attributes).not.toHaveProperty("image");
    expect(JSON.stringify(principal)).not.toContain("avatars/ada.png");
  });

  it("produces a structured-cloneable principal", () => {
    const principal = sessionToPrincipal(createTestSession());

    expect(structuredClone(principal)).toEqual(principal);
    expect(typeof principal?.id).toBe("string");
    expect(principal?.id).not.toBe("");
  });

  it("returns null for every unusable session", () => {
    expect(sessionToPrincipal(null)).toBeNull();
    expect(sessionToPrincipal(undefined)).toBeNull();
    expect(sessionToPrincipal({})).toBeNull();
    expect(
      sessionToPrincipal(createTestSession({ user: undefined })),
    ).toBeNull();
    expect(
      sessionToPrincipal(createTestSession({ user: { name: "Ada" } })),
    ).toBeNull();
    expect(
      sessionToPrincipal(createTestSession({ user: { id: "   " } })),
    ).toBeNull();
  });

  it("returns null for an expired or unparsable session expiry", () => {
    expect(
      sessionToPrincipal(
        createTestSession({
          expires: new Date(Date.now() - 1000).toISOString(),
        }),
      ),
    ).toBeNull();
    expect(
      sessionToPrincipal(createTestSession({ expires: "not-a-timestamp" })),
    ).toBeNull();
  });
});

describe("verified access token to principal mapping", () => {
  it("maps verified claims to a principal with the token channel", () => {
    expect(
      accessTokenToPrincipal({
        subject: "user_2f1a",
        email: "ada@example.test",
        name: "Ada Lovelace",
        scopes: ["engine:invoke"],
      }),
    ).toEqual({
      id: "user_2f1a",
      attributes: {
        channel: "engine-access-token",
        scopes: ["engine:invoke"],
        email: "ada@example.test",
        name: "Ada Lovelace",
      },
    });
  });

  it("omits absent optional claims", () => {
    expect(
      accessTokenToPrincipal({
        subject: "svc_reports",
        email: null,
        name: null,
        scopes: [],
      }),
    ).toEqual({
      id: "svc_reports",
      attributes: { channel: "engine-access-token", scopes: [] },
    });
  });
});

describe("app-issued access tokens", () => {
  const issuerOptions = () => ({
    signingKey: keys.signingKey,
    keyId: testKeyId,
    issuer: testIssuer,
    audience: testAudience,
    algorithm: testAlgorithm,
  });

  it("issues a token that this engine's verifier accepts", async () => {
    const token = await issueEngineAccessToken(
      createTestSession(),
      issuerOptions(),
    );
    expect(token).not.toBeNull();

    const verifier = createEngineAccessTokenVerifier({
      resolveKey: keys.resolveKey,
      issuer: testIssuer,
      audience: testAudience,
      algorithms: [testAlgorithm],
    });

    await expect(
      verifier.verify(token as string, {
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      subject: "user_2f1a",
      email: "ada@example.test",
      name: "Ada Lovelace",
      scopes: ["engine:invoke"],
    });
  });

  it("keeps the two surfaces on the same principal id", async () => {
    const session = createTestSession();
    const token = await issueEngineAccessToken(session, issuerOptions());
    const verifier = createEngineAccessTokenVerifier({
      resolveKey: keys.resolveKey,
      issuer: testIssuer,
      audience: testAudience,
      algorithms: [testAlgorithm],
    });
    const verified = await verifier.verify(token as string, {
      signal: new AbortController().signal,
    });

    expect(accessTokenToPrincipal(verified as never).id).toBe(
      sessionToPrincipal(session)?.id,
    );
  });

  it("refuses to issue a token for a session without a usable user", async () => {
    await expect(
      issueEngineAccessToken(null, issuerOptions()),
    ).resolves.toBeNull();
    await expect(
      issueEngineAccessToken(
        createTestSession({ user: { name: "Ada" } }),
        issuerOptions(),
      ),
    ).resolves.toBeNull();
  });

  it("rejects a lifetime that is not short-lived", async () => {
    await expect(
      issueEngineAccessToken(createTestSession(), {
        ...issuerOptions(),
        lifetimeSeconds: 86_400,
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });
});
