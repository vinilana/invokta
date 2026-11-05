import { createJwtBearerAuthenticator } from "@invokta/auth-jwt";
import type { McpHttpServerHandle } from "@invokta/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  exportJWK,
  generateKeyPair,
  type JSONWebKeySet,
  type JWK,
  SignJWT,
} from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  defaultSignatureAlgorithms,
  startAuthJwtBearerMcpHttp,
} from "../src/mcp-http.js";

const issuer = "https://identity.example.com";
const signingKeyId = "test-signing-key";

let server: McpHttpServerHandle;
let endpoint: URL;
let resource: string;
let signingKey: CryptoKey;
let jwks: JSONWebKeySet;

async function mintToken(scope: string): Promise<string> {
  return new SignJWT({ scope })
    .setProtectedHeader({ alg: "RS256", kid: signingKeyId, typ: "at+jwt" })
    .setIssuer(issuer)
    .setAudience(resource)
    .setSubject("user-42")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(signingKey);
}

beforeAll(async () => {
  const signing = await generateKeyPair("RS256", { extractable: true });
  signingKey = signing.privateKey;
  const jwk: JWK = {
    ...(await exportJWK(signing.publicKey)),
    kid: signingKeyId,
    alg: "RS256",
    use: "sig",
  };
  jwks = { keys: [jwk] };

  // The resource identifier must be known before the adapter starts, so an
  // ephemeral port is claimed first and reused for the real server. A
  // deployment configures its public URL instead of discovering it.
  server = await bindWithKnownResource();
  endpoint = new URL(resource);
});

// The challenge below names the same scope, so a client whose token lacks it
// learns what to request instead of retrying the same credential.
const requiredScopes = ["engine:invoke"];

function authenticatorFor(audience: string) {
  return createJwtBearerAuthenticator({
    issuer,
    audience,
    algorithms: defaultSignatureAlgorithms,
    jwks,
    requiredScopes,
  });
}

async function claimEphemeralPort(): Promise<number> {
  const probe = await startAuthJwtBearerMcpHttp({
    authenticate: authenticatorFor("https://placeholder.invalid/mcp"),
    port: 0,
  });
  const { port } = probe.address();
  await probe.close();
  return port;
}

async function bindWithKnownResource(
  attemptsLeft = 5,
): Promise<McpHttpServerHandle> {
  const port = await claimEphemeralPort();
  const candidate = `http://127.0.0.1:${port}/mcp`;
  try {
    const handle = await startAuthJwtBearerMcpHttp({
      authenticate: authenticatorFor(candidate),
      port,
      resourceMetadata: {
        resource: candidate,
        authorizationServers: [issuer],
        scopesSupported: ["engine:invoke"],
      },
      challengeScopes: requiredScopes,
    });
    resource = candidate;
    return handle;
  } catch (error) {
    // Another process may have taken the port between the probe and the bind.
    if (attemptsLeft <= 1) throw error;
    return bindWithKnownResource(attemptsLeft - 1);
  }
}

afterAll(async () => {
  await server?.close();
});

describe("protected resource metadata", () => {
  it("publishes the well-known document without authentication", async () => {
    const response = await fetch(
      new URL("/.well-known/oauth-protected-resource/mcp", endpoint),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      resource,
      authorization_servers: [issuer],
      scopes_supported: ["engine:invoke"],
    });
  });

  it("points an unauthenticated caller at the metadata document", async () => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "unauthenticated",
        method: "tools/call",
        params: { name: "identity_whoami", arguments: {} },
      }),
    });
    await response.arrayBuffer();

    expect(response.status).toBe(401);
    // The challenge carries the ordered base scopes the Resource Server
    // requires, so an OAuth client asks for them on its first authorization
    // request instead of discovering them from a second rejection.
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${
        new URL("/.well-known/oauth-protected-resource/mcp", endpoint).href
      }", scope="engine:invoke"`,
    );
  });
});

describe("authenticated MCP HTTP requests", () => {
  it("answers identity.whoami for a verified bearer token", async () => {
    const token = await mintToken("engine:invoke");
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    const client = new Client(
      { name: "auth-jwt-bearer-test", version: "0.0.0-test" },
      { capabilities: {} },
    );

    try {
      await client.connect(transport as unknown as Transport);
      await expect(
        client.callTool({ name: "identity_whoami", arguments: {} }),
      ).resolves.toMatchObject({
        structuredContent: {
          principalId: "user-42",
          attributes: { scopes: ["engine:invoke"], issuer },
        },
      });
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it("challenges a token that lacks the required scope", async () => {
    const token = await mintToken("reports:read");

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "missing-scope",
        method: "tools/call",
        params: { name: "identity_whoami", arguments: {} },
      }),
    });
    await response.arrayBuffer();

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      'scope="engine:invoke"',
    );
  });

  it("rejects a token minted for another audience", async () => {
    const foreign = await new SignJWT({ scope: "engine:invoke" })
      .setProtectedHeader({ alg: "RS256", kid: signingKeyId, typ: "at+jwt" })
      .setIssuer(issuer)
      .setAudience("https://other.example.com/mcp")
      .setSubject("user-42")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(signingKey);

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        authorization: `Bearer ${foreign}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "wrong-audience",
        method: "tools/call",
        params: { name: "identity_whoami", arguments: {} },
      }),
    });
    const body = await response.text();

    expect(response.status).toBe(401);
    expect(body).not.toContain(foreign);
  });
});
