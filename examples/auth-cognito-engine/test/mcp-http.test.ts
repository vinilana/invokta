import type { McpHttpServerHandle } from "@invokta/mcp";
import { createLocalJWKSet } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CognitoVerificationUnavailableError,
  createCognitoVerifier,
} from "../src/identity/verifier.js";
import {
  createCognitoAuthenticate,
  startCognitoMcpHttp,
} from "../src/mcp-http.js";
import {
  accessTokenClaims,
  appClientId,
  type CognitoTokenFactory,
  createTokenFactory,
  region,
  subject,
  userPoolId,
} from "./cognito-tokens.js";

let tokens: CognitoTokenFactory;
let server: McpHttpServerHandle;
let endpoint: string;

const requestHeaders = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
};

const requestBody = JSON.stringify({
  jsonrpc: "2.0",
  id: "cognito-whoami",
  method: "tools/call",
  params: { name: "identity.whoami", arguments: {} },
});

beforeAll(async () => {
  tokens = await createTokenFactory();
  server = await startCognitoMcpHttp({
    port: 0,
    verifier: createCognitoVerifier({
      region,
      userPoolId,
      appClientIds: [appClientId],
      getKey: createLocalJWKSet(tokens.jwks),
    }),
  });
  const address = server.address();
  endpoint = `http://${address.host}:${address.port}/mcp`;
});

afterAll(async () => {
  await server.close();
});

describe("cognito authenticate hook", () => {
  it("returns null when the Authorization header is missing", async () => {
    const authenticate = createCognitoAuthenticate(
      createCognitoVerifier({
        region,
        userPoolId,
        appClientIds: [appClientId],
        getKey: createLocalJWKSet(tokens.jwks),
      }),
    );

    await expect(
      authenticate({
        method: "POST",
        path: "/mcp",
        headers: { get: () => null, has: () => false },
        signal: new AbortController().signal,
      }),
    ).resolves.toBeNull();
  });

  it("returns null for a non-bearer Authorization scheme", async () => {
    const authenticate = createCognitoAuthenticate(
      createCognitoVerifier({
        region,
        userPoolId,
        appClientIds: [appClientId],
        getKey: createLocalJWKSet(tokens.jwks),
      }),
    );

    await expect(
      authenticate({
        method: "POST",
        path: "/mcp",
        headers: { get: () => "Basic YWRhOnNlY3JldA==", has: () => true },
        signal: new AbortController().signal,
      }),
    ).resolves.toBeNull();
  });

  it("propagates an infrastructure failure instead of denying the request", async () => {
    const authenticate = createCognitoAuthenticate(
      createCognitoVerifier({
        region,
        userPoolId,
        appClientIds: [appClientId],
        getKey: () => Promise.reject(new Error("connect ECONNREFUSED")),
      }),
    );
    const token = await tokens.sign(accessTokenClaims());

    await expect(
      authenticate({
        method: "POST",
        path: "/mcp",
        headers: { get: () => `Bearer ${token}`, has: () => true },
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(CognitoVerificationUnavailableError);
  });
});

describe("cognito MCP HTTP boundary", () => {
  it("answers 401 without a credential", async () => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: requestHeaders,
      body: requestBody,
    });
    await response.arrayBuffer();

    expect(response.status).toBe(401);
  });

  it("answers 401 for an id token", async () => {
    const token = await tokens.sign(accessTokenClaims({ token_use: "id" }));
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { ...requestHeaders, authorization: `Bearer ${token}` },
      body: requestBody,
    });
    await response.arrayBuffer();

    expect(response.status).toBe(401);
  });

  it("answers 401 for a token from a foreign signing key", async () => {
    const foreign = await createTokenFactory();
    const token = await foreign.sign(accessTokenClaims());
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { ...requestHeaders, authorization: `Bearer ${token}` },
      body: requestBody,
    });
    await response.arrayBuffer();

    expect(response.status).toBe(401);
  });

  it("runs the capability for a valid access token", async () => {
    const token = await tokens.sign(accessTokenClaims());
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { ...requestHeaders, authorization: `Bearer ${token}` },
      body: requestBody,
    });

    expect(response.status).toBe(200);
    const payload = await response.text();
    expect(payload).not.toContain(token);
    expect(JSON.parse(payload)).toMatchObject({
      result: {
        structuredContent: {
          principalId: subject,
          attributes: {
            clientId: appClientId,
            scopes: ["engine/invoke", "openid"],
            groups: ["support-engineers"],
          },
        },
      },
    });
  });
});
