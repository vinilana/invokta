import type { McpHttpServerHandle } from "@invokta/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  createLocalJWKSet,
  errors,
  exportJWK,
  generateKeyPair,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
  SignJWT,
} from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type ClerkSessionVerifier,
  createClerkSessionVerifier,
} from "../src/identity/verifier.js";
import { startClerkMcpHttp } from "../src/mcp-http.js";

const frontendApiUrl = "https://clean-mayfly-62.clerk.accounts.dev";
const authorizedParties = ["https://app.example.com"] as const;
const signingKeyId = "ins_test_signing_key";
let signingKey: CryptoKey;
let keys: JWTVerifyGetKey;
let sessionToken: string;
const servers: McpHttpServerHandle[] = [];

async function startServer(verifier: ClerkSessionVerifier): Promise<URL> {
  const server = await startClerkMcpHttp({ verifier, port: 0 });
  servers.push(server);
  const address = server.address();
  return new URL(`http://${address.host}:${address.port}/mcp`);
}

function toolCallBody(): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: "auth-boundary",
    method: "tools/call",
    params: { name: "identity_whoami", arguments: {} },
  });
}

async function postToolCall(
  url: URL,
  authorization?: string,
): Promise<Response> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(authorization === undefined ? {} : { authorization }),
    },
    body: toolCallBody(),
  });
  await response.arrayBuffer();
  return response;
}

beforeAll(async () => {
  const instanceKeys = await generateKeyPair("RS256", { extractable: true });
  signingKey = instanceKeys.privateKey;
  const jwks: JSONWebKeySet = {
    keys: [
      {
        ...(await exportJWK(instanceKeys.publicKey)),
        alg: "RS256",
        kid: signingKeyId,
        use: "sig",
      },
    ],
  };
  keys = createLocalJWKSet(jwks);
  // Session token v2: organization data in the compact `o` object.
  sessionToken = await new SignJWT({
    azp: authorizedParties[0],
    sid: "sess_2abcDEF",
    v: 2,
    sts: "active",
    o: { id: "org_2xyz", rol: "admin", slg: "acme" },
  })
    .setProtectedHeader({ alg: "RS256", kid: signingKeyId })
    .setIssuer(frontendApiUrl)
    .setSubject("user_2abcDEF")
    .setIssuedAt()
    .setNotBefore("0s")
    .setExpirationTime("60s")
    .sign(signingKey);
});

afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

describe("clerk MCP HTTP boundary", () => {
  it("serves the capability to a verified Clerk session token", async () => {
    const url = await startServer(
      createClerkSessionVerifier({ frontendApiUrl, authorizedParties, keys }),
    );
    const client = new Client(
      { name: "auth-clerk-test", version: "0.0.0-test" },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: `Bearer ${sessionToken}` } },
    });

    try {
      await client.connect(transport as unknown as Transport);
      await expect(
        client.callTool({ name: "identity_whoami", arguments: {} }),
      ).resolves.toMatchObject({
        structuredContent: {
          principalId: "user_2abcDEF",
          attributes: {
            sessionId: "sess_2abcDEF",
            organizationId: "org_2xyz",
            organizationRole: "admin",
          },
        },
      });
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it("answers 401 for a missing or invalid credential", async () => {
    const url = await startServer(
      createClerkSessionVerifier({ frontendApiUrl, authorizedParties, keys }),
    );

    const missing = await postToolCall(url);
    const malformed = await postToolCall(url, "Bearer not-a-jwt");
    const wrongScheme = await postToolCall(url, `Basic ${sessionToken}`);
    const expired = await postToolCall(
      url,
      `Bearer ${await new SignJWT({ azp: authorizedParties[0] })
        .setProtectedHeader({ alg: "RS256", kid: signingKeyId })
        .setIssuer(frontendApiUrl)
        .setSubject("user_2abcDEF")
        .setIssuedAt()
        .setExpirationTime("-60s")
        .sign(signingKey)}`,
    );

    expect(missing.status).toBe(401);
    expect(malformed.status).toBe(401);
    expect(wrongScheme.status).toBe(401);
    expect(expired.status).toBe(401);
  });

  it("accepts the authentication scheme case-insensitively", async () => {
    // RFC 9110 makes the scheme token case-insensitive.
    const url = await startServer(
      createClerkSessionVerifier({ frontendApiUrl, authorizedParties, keys }),
    );

    const response = await postToolCall(url, `bearer ${sessionToken}`);

    expect(response.status).toBe(200);
  });

  it("answers 500 when verification infrastructure fails", async () => {
    const url = await startServer(
      createClerkSessionVerifier({
        frontendApiUrl,
        authorizedParties,
        keys: () => Promise.reject(new errors.JWKSTimeout()),
      }),
    );

    const response = await postToolCall(url, `Bearer ${sessionToken}`);

    expect(response.status).toBe(500);
  });
});
