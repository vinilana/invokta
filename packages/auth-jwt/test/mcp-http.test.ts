import { createEngine, defineCapability } from "@invokta/core";
import { type McpHttpServerHandle, serveMcpHttp } from "@invokta/mcp";
import { exportJWK, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createJwtBearerAuthenticator } from "../src/index.js";
import { type JwksServer, startJwksServer } from "./support/jwks-server.js";
import {
  createTestKeys,
  mintToken,
  nowSeconds,
  type TestKeys,
  testAudience,
  testIssuer,
  validClaims,
} from "./support/tokens.js";

const requiredScopes = ["engine:invoke"] as const;
const metadataUrl =
  "https://engine.example.com/.well-known/oauth-protected-resource/mcp";

const whoami = defineCapability({
  title: "Who am I",
  description: "Return the verified identity of the current caller.",
  input: z.object({}),
  output: z.object({
    principalId: z.string(),
    attributes: z.record(z.string(), z.unknown()),
  }),
  access: "authenticated",
  async run({ context }) {
    return {
      principalId: context.principal?.id ?? "",
      attributes: { ...(context.principal?.attributes ?? {}) },
    };
  },
});

const engine = createEngine({
  name: "auth-jwt-test-engine",
  version: "0.0.0-test",
  capabilities: { "identity.whoami": whoami },
});

let keys: TestKeys;
let healthy: McpHttpServerHandle;
let unavailable: McpHttpServerHandle;
let rotating: McpHttpServerHandle;
let outage: JwksServer;

beforeAll(async () => {
  keys = await createTestKeys();
  outage = await startJwksServer({ kind: "status", status: 503 });

  healthy = await serveMcpHttp(engine, {
    port: 0,
    auth: {
      mode: "required",
      authenticate: createJwtBearerAuthenticator({
        issuer: testIssuer,
        audience: testAudience,
        algorithms: ["RS256"],
        jwks: keys.jwks,
        requiredScopes,
      }),
      resourceMetadata: {
        resource: testAudience,
        authorizationServers: [testIssuer],
        scopesSupported: requiredScopes,
      },
      // The challenge names exactly the scopes the authenticator requires, so
      // a client holding a token without them knows what to request.
      challengeScopes: requiredScopes,
    },
  });
  // Two RS256 keys, as an issuer publishes during key rotation.
  const current = await generateKeyPair("RS256", { extractable: true });
  const next = await generateKeyPair("RS256", { extractable: true });
  rotating = await serveMcpHttp(engine, {
    port: 0,
    auth: {
      mode: "required",
      authenticate: createJwtBearerAuthenticator({
        issuer: testIssuer,
        audience: testAudience,
        algorithms: ["RS256"],
        jwks: {
          keys: [
            { ...(await exportJWK(current.publicKey)), alg: "RS256" },
            { ...(await exportJWK(next.publicKey)), alg: "RS256" },
          ],
        },
      }),
    },
  });
  unavailable = await serveMcpHttp(engine, {
    port: 0,
    auth: {
      mode: "required",
      authenticate: createJwtBearerAuthenticator({
        issuer: testIssuer,
        audience: testAudience,
        algorithms: ["RS256"],
        jwksUrl: outage.url,
      }),
    },
  });
});

afterAll(async () => {
  await healthy?.close();
  await unavailable?.close();
  await rotating?.close();
  await outage?.close();
});

function callWhoami(
  server: McpHttpServerHandle,
  token?: string,
): Promise<Response> {
  const address = server.address();
  return fetch(`http://${address.host}:${address.port}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "whoami",
      method: "tools/call",
      params: { name: "identity_whoami", arguments: {} },
    }),
  });
}

describe("serveMcpHttp with the JWT bearer authenticator", () => {
  it("serves a tool call for a verified token", async () => {
    const token = await mintToken(keys);

    const response = await callWhoami(healthy, token);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: {
        structuredContent: {
          principalId: "user-42",
          attributes: {
            scopes: ["engine:invoke", "reports:read"],
            issuer: testIssuer,
            clientId: "reporting-cli",
          },
        },
      },
    });
  });

  it.each([
    ["a missing credential", async () => undefined],
    [
      "an expired token",
      () => mintToken(keys, validClaims(), { expiresAt: nowSeconds() - 60 }),
    ],
    [
      "a token without the required scope",
      () => mintToken(keys, validClaims({ scope: "reports:read" })),
    ],
  ])("answers 401 with the scope challenge for %s", async (_label, mint) => {
    const token = await mint();

    const response = await callWhoami(healthy, token);
    const body = await response.text();

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${metadataUrl}", scope="engine:invoke"`,
    );
    expect(JSON.parse(body)).toEqual({ error: "unauthorized" });
  });

  it("answers 401, not 500, for a forged token without a key identifier", async () => {
    const segment = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");

    const response = await callWhoami(
      rotating,
      `${segment({ alg: "RS256" })}.${segment(validClaims())}.AAAA`,
    );
    await response.arrayBuffer();

    expect(response.status).toBe(401);
  });

  it("answers a sanitized 500 when the key set cannot be fetched", async () => {
    const token = await mintToken(keys);

    const response = await callWhoami(unavailable, token);
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(body)).toEqual({ error: "authentication_failed" });
    expect(body).not.toContain(token);
    expect(body).not.toContain(outage.url.host);
    expect(outage.requests()).toBeGreaterThan(0);
  });
});
