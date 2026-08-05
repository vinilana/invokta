import type {
  McpHttpAuthenticationRequest,
  McpHttpServerHandle,
} from "@invokta/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTVerifyGetKey,
  SignJWT,
} from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBetterAuthJwtVerifier } from "../src/identity/verifier.js";
import {
  createBetterAuthAuthenticate,
  readBearerToken,
  startBetterAuthMcpHttp,
} from "../src/mcp-http.js";

const issuer = "https://app.example.com";
const audience = "https://app.example.com";
const keyId = "better-auth-test-key";
const capabilityId = "identity.whoami";

let signingKey: CryptoKey;
let keys: JWTVerifyGetKey;
let validToken: string;
let server: McpHttpServerHandle;

function headerView(headers: Readonly<Record<string, string>>) {
  return {
    get: (name: string) => headers[name.toLowerCase()] ?? null,
    has: (name: string) => headers[name.toLowerCase()] !== undefined,
  };
}

function authenticationRequest(
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal = new AbortController().signal,
): McpHttpAuthenticationRequest {
  return {
    method: "POST",
    path: "/mcp",
    headers: headerView(headers),
    signal,
  };
}

beforeAll(async () => {
  const pair = await generateKeyPair("EdDSA", {
    crv: "Ed25519",
    extractable: true,
  });
  signingKey = pair.privateKey;
  keys = createLocalJWKSet({
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: keyId, alg: "EdDSA" }],
  });
  validToken = await new SignJWT({
    email: "ada@example.com",
    emailVerified: true,
    name: "Ada Lovelace",
  })
    .setProtectedHeader({ alg: "EdDSA", kid: keyId })
    .setSubject("user_01")
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(signingKey);
  server = await startBetterAuthMcpHttp({
    port: 0,
    verifier: createBetterAuthJwtVerifier({ issuer, audience, keys }),
  });
});

afterAll(async () => {
  await server?.close();
});

describe("the Better Auth bearer parser", () => {
  it("reads exactly one Bearer credential", () => {
    expect(
      readBearerToken(headerView({ authorization: "Bearer abc.def" })),
    ).toBe("abc.def");
    expect(readBearerToken(headerView({}))).toBeNull();
    expect(
      readBearerToken(headerView({ authorization: "Basic abc" })),
    ).toBeNull();
    expect(readBearerToken(headerView({ authorization: "Bearer" }))).toBeNull();
    expect(
      readBearerToken(headerView({ authorization: "Bearer a b" })),
    ).toBeNull();
  });
});

describe("the Better Auth authentication hook", () => {
  it("maps a verified Better Auth JWT to a minimal principal", async () => {
    const authenticate = createBetterAuthAuthenticate(
      createBetterAuthJwtVerifier({ issuer, audience, keys }),
    );

    const principal = await authenticate(
      authenticationRequest({ authorization: `Bearer ${validToken}` }),
    );

    expect(principal).toEqual({
      id: "user_01",
      attributes: {
        email: "ada@example.com",
        emailVerified: true,
        name: "Ada Lovelace",
      },
    });
    expect(JSON.stringify(principal)).not.toContain(validToken);
  });

  it("returns null for every invalid credential class", async () => {
    const authenticate = createBetterAuthAuthenticate(
      createBetterAuthJwtVerifier({ issuer, audience, keys }),
    );
    const expired = await new SignJWT({})
      .setProtectedHeader({ alg: "EdDSA", kid: keyId })
      .setSubject("user_01")
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime("-1s")
      .sign(signingKey);

    await expect(authenticate(authenticationRequest({}))).resolves.toBeNull();
    await expect(
      authenticate(authenticationRequest({ authorization: "Bearer nonsense" })),
    ).resolves.toBeNull();
    await expect(
      authenticate(
        authenticationRequest({ authorization: `Bearer ${expired}` }),
      ),
    ).resolves.toBeNull();
    await expect(
      authenticate(authenticationRequest({ authorization: validToken })),
    ).resolves.toBeNull();
  });

  it("rejects when the JWKS endpoint cannot be reached", async () => {
    const authenticate = createBetterAuthAuthenticate(
      createBetterAuthJwtVerifier({
        issuer,
        audience,
        keys: () => Promise.reject(new TypeError("fetch failed")),
      }),
    );

    await expect(
      authenticate(
        authenticationRequest({ authorization: `Bearer ${validToken}` }),
      ),
    ).rejects.toThrow();
  });
});

describe("the served MCP HTTP boundary", () => {
  it("answers 401 before the engine runs for a missing or invalid token", async () => {
    const address = server.address();
    const url = new URL(`http://${address.host}:${address.port}/mcp`);
    const headers = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    };
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: "auth-boundary",
      method: "tools/call",
      params: { name: capabilityId, arguments: {} },
    });

    const missing = await fetch(url, { method: "POST", headers, body });
    const invalid = await fetch(url, {
      method: "POST",
      headers: { ...headers, authorization: "Bearer nonsense" },
      body,
    });

    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
    await Promise.all([missing.arrayBuffer(), invalid.arrayBuffer()]);
  });

  it("runs identity.whoami for a verified Better Auth JWT", async () => {
    const address = server.address();
    const url = new URL(`http://${address.host}:${address.port}/mcp`);
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: `Bearer ${validToken}` } },
    });
    const client = new Client(
      { name: "better-auth-http-test", version: "0.0.0-test" },
      { capabilities: {} },
    );

    try {
      await client.connect(transport as unknown as Transport);
      await expect(
        client.callTool({ name: capabilityId, arguments: {} }),
      ).resolves.toMatchObject({
        structuredContent: {
          principalId: "user_01",
          attributes: {
            email: "ada@example.com",
            emailVerified: true,
            name: "Ada Lovelace",
          },
        },
      });
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});
