import type { McpHttpServerHandle } from "@invokta/mcp";
import { afterEach, describe, expect, it } from "vitest";

import {
  type ApiKeyRecord,
  type ApiKeyRegistry,
  createApiKeyVerifier,
  createInMemoryApiKeyRegistry,
  hashApiKeySecret,
} from "../src/identity/verifier.js";
import {
  createApiKeyAuthenticate,
  readBearerCredential,
  startApiKeyMcpHttp,
} from "../src/mcp-http.js";

const secret = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY";
const apiKey = `svc_reports_2026a.${secret}`;
const records: ReadonlyArray<ApiKeyRecord> = [
  {
    keyId: "svc_reports_2026a",
    secretHash: hashApiKeySecret(secret),
    serviceName: "reports-worker",
    scopes: ["identity:read"],
  },
];

const openServers: McpHttpServerHandle[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

async function start(registry?: ApiKeyRegistry): Promise<McpHttpServerHandle> {
  const server = await startApiKeyMcpHttp({
    verifier: createApiKeyVerifier({
      registry: registry ?? createInMemoryApiKeyRegistry(records),
    }),
    port: 0,
  });
  openServers.push(server);
  return server;
}

function callWhoami(
  server: McpHttpServerHandle,
  credential?: string,
): Promise<Response> {
  const address = server.address();
  return fetch(`http://${address.host}:${address.port}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(credential === undefined
        ? {}
        : { authorization: `Bearer ${credential}` }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "whoami",
      method: "tools/call",
      params: { name: "identity.whoami", arguments: {} },
    }),
  });
}

function headerView(value: string | null) {
  return {
    get: (name: string) => (name === "authorization" ? value : null),
    has: (name: string) => name === "authorization" && value !== null,
  };
}

describe("bearer credential parsing", () => {
  it("reads exactly one Bearer credential", () => {
    expect(readBearerCredential(headerView(`Bearer ${apiKey}`))).toBe(apiKey);
  });

  it("accepts the authentication scheme case-insensitively", () => {
    // RFC 9110 makes the scheme token case-insensitive.
    expect(readBearerCredential(headerView(`bearer ${apiKey}`))).toBe(apiKey);
  });

  it.each([
    ["a missing header", null],
    ["another scheme", `Basic ${apiKey}`],
    ["a missing credential", "Bearer "],
    ["a credential with whitespace", `Bearer ${apiKey} extra`],
  ])("returns null for %s", (_label, value) => {
    expect(readBearerCredential(headerView(value))).toBeNull();
  });
});

describe("api key authentication hook", () => {
  it("returns a principal for a valid key and null for every invalid class", async () => {
    const authenticate = createApiKeyAuthenticate(
      createApiKeyVerifier({ registry: createInMemoryApiKeyRegistry(records) }),
    );
    const request = (authorization: string | null) => ({
      path: "/mcp",
      method: "POST",
      headers: headerView(authorization),
      signal: new AbortController().signal,
    });

    await expect(authenticate(request(`Bearer ${apiKey}`))).resolves.toEqual({
      id: "reports-worker",
      attributes: { keyId: "svc_reports_2026a", scopes: ["identity:read"] },
    });
    await expect(authenticate(request(null))).resolves.toBeNull();
    await expect(authenticate(request("Bearer nonsense"))).resolves.toBeNull();
    await expect(
      authenticate(request(`Bearer svc_unknown.${secret}`)),
    ).resolves.toBeNull();
  });
});

describe("mcp http boundary", () => {
  it("answers 401 for a missing or invalid key and keeps the key out of the response", async () => {
    const server = await start();

    const missing = await callWhoami(server);
    const malformed = await callWhoami(server, "nonsense");
    const unknown = await callWhoami(server, `svc_unknown.${secret}`);
    const wrongSecret = await callWhoami(
      server,
      "svc_reports_2026a.ZmVkY2JhOTg3NjU0MzIxMGZlZGNiYTk4NzY1NDMyMTA",
    );

    expect(missing.status).toBe(401);
    expect(malformed.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrongSecret.status).toBe(401);
    const bodies = await Promise.all(
      [missing, malformed, unknown, wrongSecret].map((response) =>
        response.text(),
      ),
    );
    for (const body of bodies) expect(body).not.toContain(secret);
  });

  it("serves identity.whoami for a valid key", async () => {
    const server = await start();

    const response = await callWhoami(server, apiKey);

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      result: {
        structuredContent: {
          principalId: "reports-worker",
          attributes: { keyId: "svc_reports_2026a", scopes: ["identity:read"] },
        },
      },
    });
    expect(JSON.stringify(body)).not.toContain(secret);
  });

  it("answers 500 when the key registry cannot complete the lookup", async () => {
    const server = await start({
      async findByKeyId() {
        throw new Error("registry unavailable");
      },
    });

    const response = await callWhoami(server, apiKey);

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).not.toContain(secret);
    expect(body).not.toContain("registry unavailable");
  });
});
