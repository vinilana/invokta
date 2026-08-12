import type { McpHttpServerHandle } from "@invokta/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  createSupabaseVerifier,
  type SupabaseAccessTokenVerifier,
  SupabaseVerificationUnavailableError,
} from "../src/identity/verifier.js";
import {
  createSupabaseAuthenticate,
  startSupabaseMcpHttp,
} from "../src/mcp-http.js";
import {
  createTokenFactory,
  issuer,
  type SupabaseTokenFactory,
  sessionId,
  subject,
} from "./tokens.js";

let tokens: SupabaseTokenFactory;
const servers: McpHttpServerHandle[] = [];

async function start(verifier: SupabaseAccessTokenVerifier): Promise<URL> {
  const server = await startSupabaseMcpHttp({ verifier, port: 0 });
  servers.push(server);
  const address = server.address();
  return new URL(`http://${address.host}:${address.port}/mcp`);
}

function callBody(): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: "whoami",
    method: "tools/call",
    params: { name: "identity_whoami", arguments: {} },
  });
}

const headers = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
};

beforeAll(async () => {
  tokens = await createTokenFactory();
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("Supabase MCP HTTP boundary", () => {
  it("answers 401 for a missing, non-bearer, or invalid credential", async () => {
    const url = await start(
      createSupabaseVerifier({ issuer, keys: tokens.keys }),
    );
    const expired = await tokens.sign(
      {},
      { expiresAt: Math.floor(Date.now() / 1000) - 3_600 },
    );

    const responses = await Promise.all([
      fetch(url, { method: "POST", headers, body: callBody() }),
      fetch(url, {
        method: "POST",
        headers: { ...headers, authorization: "Basic YWRhOnNlY3JldA==" },
        body: callBody(),
      }),
      fetch(url, {
        method: "POST",
        headers: { ...headers, authorization: "Bearer not-a-supabase-token" },
        body: callBody(),
      }),
      fetch(url, {
        method: "POST",
        headers: { ...headers, authorization: `Bearer ${expired}` },
        body: callBody(),
      }),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain(expired);
    }
  });

  it("answers 500 when verification infrastructure fails", async () => {
    const url = await start({
      verify() {
        return Promise.reject(new SupabaseVerificationUnavailableError());
      },
    });

    const response = await fetch(url, {
      method: "POST",
      headers: { ...headers, authorization: `Bearer ${await tokens.sign()}` },
      body: callBody(),
    });

    expect(response.status).toBe(500);
    await response.arrayBuffer();
  });

  it("serves identity.whoami to a verified Supabase user", async () => {
    const url = await start(
      createSupabaseVerifier({ issuer, keys: tokens.keys }),
    );
    const token = await tokens.sign();
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    const client = new Client(
      { name: "auth-supabase-test", version: "0.0.0-test" },
      { capabilities: {} },
    );

    try {
      await client.connect(transport as unknown as Transport);
      await expect(
        client.callTool({ name: "identity_whoami", arguments: {} }),
      ).resolves.toMatchObject({
        structuredContent: {
          principalId: subject,
          attributes: {
            role: "authenticated",
            email: "ada@example.com",
            sessionId,
            isAnonymous: false,
          },
        },
      });
    } finally {
      await client.close();
    }
  });
});

describe("createSupabaseAuthenticate", () => {
  function request(authorization: string | null) {
    return {
      method: "POST",
      path: "/mcp",
      signal: new AbortController().signal,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "authorization" ? authorization : null,
        has: (name: string) =>
          name.toLowerCase() === "authorization" && authorization !== null,
      },
    };
  }

  it("returns null without asking the verifier when no bearer token is present", async () => {
    let calls = 0;
    const authenticate = createSupabaseAuthenticate({
      verify() {
        calls += 1;
        return Promise.resolve(null);
      },
    });

    await expect(authenticate(request(null))).resolves.toBeNull();
    await expect(authenticate(request("Bearer"))).resolves.toBeNull();
    await expect(authenticate(request("Bearer  a b"))).resolves.toBeNull();
    await expect(authenticate(request("token abc"))).resolves.toBeNull();
    expect(calls).toBe(0);
  });

  it("maps a verified identity to a principal", async () => {
    const authenticate = createSupabaseAuthenticate(
      createSupabaseVerifier({ issuer, keys: tokens.keys }),
    );

    await expect(
      authenticate(request(`Bearer ${await tokens.sign()}`)),
    ).resolves.toEqual({
      id: subject,
      attributes: {
        role: "authenticated",
        email: "ada@example.com",
        sessionId,
        isAnonymous: false,
      },
    });
  });

  it("accepts the authentication scheme case-insensitively", async () => {
    // RFC 9110 makes the scheme token case-insensitive.
    const authenticate = createSupabaseAuthenticate(
      createSupabaseVerifier({ issuer, keys: tokens.keys }),
    );

    await expect(
      authenticate(request(`bearer ${await tokens.sign()}`)),
    ).resolves.toMatchObject({ id: subject });
  });
});
