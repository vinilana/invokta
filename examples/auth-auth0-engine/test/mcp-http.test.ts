import type { McpHttpServerHandle } from "@invokta/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAuth0AccessTokenVerifier } from "../src/identity/verifier.js";
import { startAuth0McpHttp } from "../src/mcp-http.js";
import {
  type Auth0TokenFactory,
  createAuth0TokenFactory,
  testAudience,
  testDomain,
  testIssuer,
  validClaims,
} from "./support/auth0-tokens.js";

const resource = "https://engine.example.com/mcp";
const capabilityId = "identity.whoami";

let tokens: Auth0TokenFactory;
let healthy: McpHttpServerHandle;
let unavailable: McpHttpServerHandle;

function endpoint(server: McpHttpServerHandle): URL {
  const address = server.address();
  return new URL(`http://${address.host}:${address.port}/mcp`);
}

function callToolRequest(): RequestInit {
  return {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "whoami",
      method: "tools/call",
      params: { name: capabilityId, arguments: {} },
    }),
  };
}

function createVerifier(keySource: Auth0TokenFactory["keySource"]) {
  return createAuth0AccessTokenVerifier({
    domain: testDomain,
    audience: testAudience,
    keySource,
  });
}

beforeAll(async () => {
  tokens = await createAuth0TokenFactory();
  healthy = await startAuth0McpHttp({
    domain: testDomain,
    audience: testAudience,
    verifier: createVerifier(tokens.keySource),
    host: "127.0.0.1",
    port: 0,
    resource,
    scopesSupported: ["orders:read"],
  });
  unavailable = await startAuth0McpHttp({
    domain: testDomain,
    audience: testAudience,
    verifier: createVerifier(tokens.failingKeySource),
    host: "127.0.0.1",
    port: 0,
  });
});

afterAll(async () => {
  await healthy?.close();
  await unavailable?.close();
});

describe("auth0 MCP HTTP boundary", () => {
  it("serves identity.whoami to a caller holding a valid access token", async () => {
    const token = await tokens.sign(
      validClaims({ permissions: ["orders:read"] }),
    );
    const transport = new StreamableHTTPClientTransport(endpoint(healthy), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    const client = new Client(
      { name: "auth0-recipe-test", version: "0.0.0-test" },
      { capabilities: {} },
    );

    try {
      await client.connect(transport as unknown as Transport);
      await expect(
        client.callTool({ name: capabilityId, arguments: {} }),
      ).resolves.toMatchObject({
        structuredContent: {
          principalId: "auth0|64f0c0ffee0000000000abcd",
          attributes: {
            scopes: ["openid", "profile", "orders:read", "orders:write"],
            permissions: ["orders:read"],
          },
        },
      });
    } finally {
      await client.close();
    }
  });

  it("answers 401 with the Auth0 discovery challenge for an invalid credential", async () => {
    const url = endpoint(healthy);

    const missing = await fetch(url, callToolRequest());
    const forged = await fetch(url, {
      ...callToolRequest(),
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        authorization: `Bearer ${await tokens.signWithForeignKey(validClaims())}`,
      },
    });

    expect(missing.status).toBe(401);
    expect(forged.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="https://engine.example.com/.well-known/oauth-protected-resource/mcp"`,
    );
    await Promise.all([missing.arrayBuffer(), forged.arrayBuffer()]);
  });

  it("publishes the tenant as the authorization server", async () => {
    const address = healthy.address();
    const response = await fetch(
      `http://${address.host}:${address.port}/.well-known/oauth-protected-resource/mcp`,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      resource,
      authorization_servers: [testIssuer],
      scopes_supported: ["orders:read"],
    });
  });

  it("answers 500 when the tenant JWKS cannot be reached", async () => {
    const token = await tokens.sign(validClaims());

    const response = await fetch(endpoint(unavailable), {
      ...callToolRequest(),
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
    });
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).not.toContain(token);
  });
});
