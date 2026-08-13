import type { McpHttpServerHandle } from "@invokta/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTVerifyGetKey,
  SignJWT,
} from "jose";
import { afterEach, describe, expect, it } from "vitest";
import {
  createWorkOsAccessTokenVerifier,
  type WorkOsAccessTokenVerifier,
  WorkOsVerificationUnavailableError,
} from "../src/identity/verifier.js";
import {
  createWorkOsAuthenticate,
  resolveWorkOsConfiguration,
  startWorkOsMcpHttp,
} from "../src/mcp-http.js";

const clientId = "client_01JTESTCLIENTID";
const issuer = "https://api.workos.com/";
const audience = "https://engine.example.com/mcp";
const keyId = "workos-test-key";
const signing = await generateKeyPair("RS256", { extractable: true });
const publicJwk: JWK = {
  ...(await exportJWK(signing.publicKey)),
  kid: keyId,
  alg: "RS256",
  use: "sig",
};
const keys: JWTVerifyGetKey = createLocalJWKSet({ keys: [publicJwk] });
const verifier = createWorkOsAccessTokenVerifier({
  clientId,
  audience,
  keys,
});

async function mintAccessToken(
  claims: Readonly<Record<string, unknown>> = {},
): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "RS256", kid: keyId })
    .setSubject("user_01JTESTUSER")
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(signing.privateKey);
}

function authenticationRequest(headers: Readonly<Record<string, string>>) {
  const normalized = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return {
    path: "/mcp",
    method: "POST",
    headers: {
      get: (name: string) => normalized.get(name.toLowerCase()) ?? null,
      has: (name: string) => normalized.has(name.toLowerCase()),
    },
    signal: new AbortController().signal,
  };
}

const servers: McpHttpServerHandle[] = [];

async function startServer(
  serverVerifier: WorkOsAccessTokenVerifier,
): Promise<URL> {
  const server = await startWorkOsMcpHttp({
    verifier: serverVerifier,
    host: "127.0.0.1",
    port: 0,
  });
  servers.push(server);
  const address = server.address();
  return new URL(`http://${address.host}:${address.port}/mcp`);
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("WorkOS authentication hook", () => {
  const authenticate = createWorkOsAuthenticate(verifier);

  it("returns a principal for a valid bearer credential", async () => {
    const token = await mintAccessToken({
      sid: "session_01JTESTSESSION",
      org_id: "org_01JTESTORG",
      role: "admin",
      permissions: ["widgets:read"],
    });

    await expect(
      authenticate(authenticationRequest({ authorization: `Bearer ${token}` })),
    ).resolves.toEqual({
      id: "user_01JTESTUSER",
      attributes: {
        sid: "session_01JTESTSESSION",
        org_id: "org_01JTESTORG",
        role: "admin",
        permissions: ["widgets:read"],
      },
    });
  });

  it("accepts the authentication scheme case-insensitively", async () => {
    // RFC 9110 makes the scheme token case-insensitive.
    const token = await mintAccessToken({});

    await expect(
      authenticate(authenticationRequest({ authorization: `bearer ${token}` })),
    ).resolves.toMatchObject({ id: "user_01JTESTUSER" });
  });

  it("returns null when the Authorization header is missing", async () => {
    await expect(authenticate(authenticationRequest({}))).resolves.toBeNull();
  });

  it("returns null for a non-bearer scheme", async () => {
    await expect(
      authenticate(authenticationRequest({ authorization: "Basic abc" })),
    ).resolves.toBeNull();
  });

  it("returns null for an empty bearer credential", async () => {
    await expect(
      authenticate(authenticationRequest({ authorization: "Bearer " })),
    ).resolves.toBeNull();
  });

  it("rejects when verification infrastructure fails", async () => {
    const failing = createWorkOsAuthenticate({
      verify() {
        return Promise.reject(new WorkOsVerificationUnavailableError());
      },
    });

    await expect(
      failing(authenticationRequest({ authorization: "Bearer any.token" })),
    ).rejects.toBeInstanceOf(WorkOsVerificationUnavailableError);
  });
});

describe("WorkOS MCP HTTP boundary", () => {
  it("answers an authenticated whoami call with the verified identity", async () => {
    const url = await startServer(verifier);
    const token = await mintAccessToken({
      sid: "session_01JTESTSESSION",
      org_id: "org_01JTESTORG",
      role: "admin",
      permissions: ["widgets:read"],
    });
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    const client = new Client(
      { name: "auth-workos-test", version: "0.0.0-test" },
      { capabilities: {} },
    );

    try {
      await client.connect(transport as unknown as Transport);
      await expect(
        client.callTool({ name: "identity_whoami", arguments: {} }),
      ).resolves.toMatchObject({
        structuredContent: {
          principalId: "user_01JTESTUSER",
          attributes: {
            sid: "session_01JTESTSESSION",
            org_id: "org_01JTESTORG",
            role: "admin",
            permissions: ["widgets:read"],
          },
        },
      });
    } finally {
      await client.close();
    }
  });

  it("answers a missing or invalid credential with HTTP 401", async () => {
    const url = await startServer(verifier);
    const headers = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    };
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: "auth-boundary",
      method: "tools/call",
      params: { name: "identity_whoami", arguments: {} },
    });

    const missing = await fetch(url, { method: "POST", headers, body });
    const invalid = await fetch(url, {
      method: "POST",
      headers: { ...headers, authorization: "Bearer not-a-jwt" },
      body,
    });

    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
    await Promise.all([missing.arrayBuffer(), invalid.arrayBuffer()]);
  });

  it("answers a verification infrastructure failure with HTTP 500", async () => {
    const url = await startServer({
      verify() {
        return Promise.reject(new WorkOsVerificationUnavailableError());
      },
    });
    const response = await fetch(url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        authorization: "Bearer any.token",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "auth-boundary",
        method: "tools/call",
        params: { name: "identity_whoami", arguments: {} },
      }),
    });
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).not.toContain("any.token");
  });
});

describe("WorkOS boundary configuration", () => {
  it("selects the session-token flavor when no MCP resource is set", () => {
    const configuration = resolveWorkOsConfiguration({
      WORKOS_CLIENT_ID: clientId,
    });

    expect(configuration).toEqual({ verifier: { clientId } });
  });

  it("derives the MCP OAuth flavor from the AuthKit domain", () => {
    const configuration = resolveWorkOsConfiguration({
      WORKOS_CLIENT_ID: clientId,
      WORKOS_MCP_RESOURCE: "https://engine.example.com/mcp",
      WORKOS_AUTHKIT_DOMAIN: "https://example-env.authkit.app",
    });

    expect(configuration).toEqual({
      verifier: {
        clientId,
        issuer: "https://example-env.authkit.app",
        jwksUrl: "https://example-env.authkit.app/oauth2/jwks",
        audience: "https://engine.example.com/mcp",
      },
      resourceMetadata: {
        resource: "https://engine.example.com/mcp",
        authorizationServers: ["https://example-env.authkit.app"],
      },
    });
  });

  it("accepts explicit issuer and JWKS overrides for the OAuth flavor", () => {
    const configuration = resolveWorkOsConfiguration({
      WORKOS_CLIENT_ID: clientId,
      WORKOS_MCP_RESOURCE: "https://engine.example.com/mcp",
      WORKOS_ISSUER: "https://auth.example.com",
      WORKOS_JWKS_URL: "https://auth.example.com/oauth2/jwks",
    });

    expect(configuration.verifier).toMatchObject({
      issuer: "https://auth.example.com",
      jwksUrl: "https://auth.example.com/oauth2/jwks",
      audience: "https://engine.example.com/mcp",
    });
    expect(configuration.resourceMetadata).toEqual({
      resource: "https://engine.example.com/mcp",
      authorizationServers: ["https://auth.example.com"],
    });
  });

  it("fails fast when the MCP resource has no issuer source", () => {
    // Session-token defaults would answer 401 to both token flavors and
    // advertise an authorization server that serves no AS metadata.
    expect(() =>
      resolveWorkOsConfiguration({
        WORKOS_CLIENT_ID: clientId,
        WORKOS_MCP_RESOURCE: "https://engine.example.com/mcp",
      }),
    ).toThrow(/WORKOS_AUTHKIT_DOMAIN/u);
  });

  it("fails fast without a client id", () => {
    expect(() => resolveWorkOsConfiguration({})).toThrow(/WORKOS_CLIENT_ID/u);
  });
});
