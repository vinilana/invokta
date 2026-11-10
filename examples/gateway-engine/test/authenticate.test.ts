import { createJwtBearerAuthenticator } from "@invokta/auth-jwt";
import {
  type GatewayAuthenticationRequest,
  hashApiKey,
} from "@invokta/gateway";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import {
  createGatewayAuthenticator,
  parseApiKeys,
  readJwtSettings,
} from "../src/access/authenticate.js";

const issuer = "https://identity.acme.example";
const audience = "http://127.0.0.1:3300/mcp";

function request(
  headers: Record<string, string>,
): GatewayAuthenticationRequest {
  const values = new Headers(headers);
  return {
    path: "/mcp",
    method: "POST",
    headers: {
      get: (name) => values.get(name),
      has: (name) => values.has(name),
    },
    signal: new AbortController().signal,
  };
}

async function localJwt() {
  const { publicKey, privateKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256" };
  const authenticate = createJwtBearerAuthenticator({
    issuer,
    audience,
    algorithms: ["ES256"],
    jwks: { keys: [jwk] },
  });
  const mint = (scope: string) =>
    new SignJWT({ scope })
      .setProtectedHeader({ alg: "ES256", kid: "k1" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject("user-42")
      .setExpirationTime("5m")
      .sign(privateKey);
  return { authenticate, mint };
}

describe("parseApiKeys", () => {
  it("maps configured digests, scopes, and the agent flag", async () => {
    const sha256 = await hashApiKey("support-bot-key");
    expect(
      parseApiKeys(
        JSON.stringify([
          { id: "support-bot", sha256, scopes: ["support"], agent: true },
          { id: "reader", sha256: "a".repeat(64) },
        ]),
      ),
    ).toEqual([
      {
        id: "support-bot",
        sha256,
        attributes: { scopes: ["support"], agent: true },
      },
      { id: "reader", sha256: "a".repeat(64), attributes: { scopes: [] } },
    ]);
  });

  it.each([
    "not json",
    "[]",
    "{}",
    '[{"id":"x"}]',
    '[{"id":"x","sha256":"y","scopes":"support"}]',
    '[{"id":"x","sha256":"y","agent":"yes"}]',
  ])("rejects %s", (json) => {
    expect(() => parseApiKeys(json)).toThrow(TypeError);
  });
});

describe("readJwtSettings", () => {
  it("requires the three JWT variables together", () => {
    expect(readJwtSettings({})).toBeUndefined();
    expect(
      readJwtSettings({
        GATEWAY_JWT_ISSUER: issuer,
        GATEWAY_JWT_AUDIENCE: audience,
        GATEWAY_JWT_JWKS_URL: `${issuer}/.well-known/jwks.json`,
      }),
    ).toEqual({ issuer, audience, jwksUrl: `${issuer}/.well-known/jwks.json` });
    expect(() => readJwtSettings({ GATEWAY_JWT_ISSUER: issuer })).toThrow(
      TypeError,
    );
  });
});

describe("createGatewayAuthenticator", () => {
  it("accepts a JWT for people and an API key for automations", async () => {
    const jwt = await localJwt();
    const authenticate = createGatewayAuthenticator({
      jwt: jwt.authenticate,
      apiKeys: parseApiKeys(
        JSON.stringify([
          {
            id: "finance-bot",
            sha256: await hashApiKey("finance-bot-key"),
            scopes: ["billing:read", "billing:refund"],
          },
        ]),
      ),
    });

    await expect(
      authenticate(
        request({
          authorization: `Bearer ${await jwt.mint("support kb:read")}`,
        }),
      ),
    ).resolves.toMatchObject({
      id: "user-42",
      attributes: { scopes: ["support", "kb:read"] },
    });
    await expect(
      authenticate(request({ "x-api-key": "finance-bot-key" })),
    ).resolves.toEqual({
      id: "finance-bot",
      attributes: { scopes: ["billing:read", "billing:refund"] },
    });
    await expect(
      authenticate(request({ authorization: "Bearer not-a-jwt" })),
    ).resolves.toBeNull();
    await expect(authenticate(request({}))).resolves.toBeNull();
  });

  it("needs at least one method", () => {
    expect(() => createGatewayAuthenticator({})).toThrow(TypeError);
  });
});
