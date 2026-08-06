import type { McpHttpServerHandle } from "@invokta/mcp";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { issueEngineAccessToken } from "../src/identity/issuer.js";
import { createEngineAccessTokenVerifier } from "../src/identity/verifier.js";
import {
  createAuthjsAuthenticate,
  startAuthjsMcpHttp,
} from "../src/mcp-http.js";
import {
  createTestKeyMaterial,
  createTestSession,
  signTestToken,
  testAlgorithm,
  testAudience,
  testIssuer,
  testKeyId,
} from "./support/tokens.js";

type KeyMaterial = Awaited<ReturnType<typeof createTestKeyMaterial>>;

let keys: KeyMaterial;
let server: McpHttpServerHandle | undefined;

beforeAll(async () => {
  keys = await createTestKeyMaterial();
});

afterEach(async () => {
  await server?.close();
  server = undefined;
});

function verifier() {
  return createEngineAccessTokenVerifier({
    resolveKey: keys.resolveKey,
    issuer: testIssuer,
    audience: testAudience,
    algorithms: [testAlgorithm],
  });
}

function headerView(authorization: string | null) {
  return {
    get: (name: string) =>
      name.toLowerCase() === "authorization" ? authorization : null,
    has: (name: string) =>
      name.toLowerCase() === "authorization" && authorization !== null,
  };
}

function authenticationRequest(authorization: string | null) {
  return {
    path: "/mcp",
    method: "POST",
    headers: headerView(authorization),
    signal: new AbortController().signal,
  };
}

async function issueToken(): Promise<string> {
  const token = await issueEngineAccessToken(createTestSession(), {
    signingKey: keys.signingKey,
    keyId: testKeyId,
    issuer: testIssuer,
    audience: testAudience,
    algorithm: testAlgorithm,
  });
  if (token === null) throw new Error("The test session must yield a token.");
  return token;
}

/** Reads a JSON-RPC payload from a JSON or SSE MCP response body. */
function readJsonRpcPayload(contentType: string, body: string): unknown {
  if (contentType.includes("text/event-stream")) {
    const line = body
      .split("\n")
      .find((candidate) => candidate.startsWith("data:"));
    if (line === undefined) throw new Error("Expected an SSE data line.");
    return JSON.parse(line.slice("data:".length).trim()) as unknown;
  }
  return JSON.parse(body) as unknown;
}

describe("MCP HTTP authentication hook", () => {
  it("returns null for a missing or malformed Authorization header", async () => {
    const authenticate = createAuthjsAuthenticate(verifier());

    await expect(authenticate(authenticationRequest(null))).resolves.toBeNull();
    await expect(
      authenticate(authenticationRequest("Basic dXNlcjpwYXNz")),
    ).resolves.toBeNull();
    await expect(
      authenticate(authenticationRequest("Bearer ")),
    ).resolves.toBeNull();
    await expect(
      authenticate(authenticationRequest("Bearer not-a-jwt")),
    ).resolves.toBeNull();
  });

  it("accepts the authentication scheme case-insensitively", async () => {
    // RFC 9110 makes the scheme token case-insensitive.
    const token = await issueToken();
    const authenticate = createAuthjsAuthenticate(verifier());

    await expect(
      authenticate(authenticationRequest(`bearer ${token}`)),
    ).resolves.toMatchObject({ id: "user_2f1a" });
  });

  it("returns a principal that carries no token material", async () => {
    const token = await issueToken();
    const authenticate = createAuthjsAuthenticate(verifier());

    const principal = await authenticate(
      authenticationRequest(`Bearer ${token}`),
    );

    expect(principal).toEqual({
      id: "user_2f1a",
      attributes: {
        channel: "engine-access-token",
        scopes: ["engine:invoke"],
        email: "ada@example.test",
        name: "Ada Lovelace",
      },
    });
    expect(JSON.stringify(principal)).not.toContain(token);
    for (const segment of token.split(".")) {
      expect(JSON.stringify(principal)).not.toContain(segment);
    }
    expect(structuredClone(principal)).toEqual(principal);
  });

  it("serves the capability over authenticated stateless HTTP", async () => {
    server = await startAuthjsMcpHttp({ verifier: verifier(), port: 0 });
    const address = server.address();
    const url = new URL(`http://${address.host}:${address.port}/mcp`);
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: "whoami-1",
      method: "tools/call",
      params: { name: "identity.whoami", arguments: {} },
    });
    const headers = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    };

    const missing = await fetch(url, { method: "POST", headers, body });
    expect(missing.status).toBe(401);
    await missing.arrayBuffer();

    const expiredSeconds = Math.floor(Date.now() / 1000);
    const expired = await signTestToken(keys.signingKey, {
      issuedAt: expiredSeconds - 3600,
      expiresAt: expiredSeconds - 60,
    });
    const rejected = await fetch(url, {
      method: "POST",
      headers: { ...headers, authorization: `Bearer ${expired}` },
      body,
    });
    expect(rejected.status).toBe(401);
    await rejected.arrayBuffer();

    const token = await issueToken();
    const accepted = await fetch(url, {
      method: "POST",
      headers: { ...headers, authorization: `Bearer ${token}` },
      body,
    });
    expect(accepted.status).toBe(200);
    const payload = readJsonRpcPayload(
      accepted.headers.get("content-type") ?? "",
      await accepted.text(),
    );

    expect(payload).toMatchObject({
      result: {
        structuredContent: {
          principalId: "user_2f1a",
          attributes: {
            channel: "engine-access-token",
            scopes: ["engine:invoke"],
          },
        },
      },
    });
  });
});
