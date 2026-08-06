import type { McpHttpServerHandle } from "@invokta/mcp";
import { afterEach, describe, expect, it } from "vitest";

import { firebaseIssuer } from "../src/identity/principal.js";
import type {
  FirebaseIdTokenClaims,
  FirebaseIdTokenVerifier,
} from "../src/identity/verifier.js";
import { startFirebaseMcpHttp } from "../src/mcp-http.js";

const projectId = "demo-invokta-engine";
const idToken = "header.payload.signature";

const verifiedClaims: FirebaseIdTokenClaims = {
  iss: firebaseIssuer(projectId),
  aud: projectId,
  sub: "uid-123",
  email: "ada@example.com",
  email_verified: true,
  firebase: { sign_in_provider: "password" },
  role: "support-agent",
};

const openServers: McpHttpServerHandle[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

async function startServer(
  verifier: FirebaseIdTokenVerifier,
): Promise<McpHttpServerHandle> {
  const server = await startFirebaseMcpHttp({
    verifier,
    projectId,
    customClaimNames: ["role"],
    port: 0,
  });
  openServers.push(server);
  return server;
}

function endpoint(server: McpHttpServerHandle): string {
  const address = server.address();
  return `http://${address.host}:${address.port}/mcp`;
}

async function callWhoami(
  server: McpHttpServerHandle,
  authorization?: string,
  toolArguments: Readonly<Record<string, unknown>> = {},
): Promise<Response> {
  return fetch(endpoint(server), {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(authorization === undefined ? {} : { authorization }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "whoami",
      method: "tools/call",
      params: { name: "identity.whoami", arguments: toolArguments },
    }),
  });
}

describe("firebase mcp http composition root", () => {
  it("serves the capability for a verified id token", async () => {
    const server = await startServer({
      verifyIdToken: async () => verifiedClaims,
    });

    // The spoofed argument must not reach the result: identity comes from the
    // authenticated principal, never from tool input.
    const response = await callWhoami(server, `Bearer ${idToken}`, {
      principalId: "attacker",
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      result: {
        structuredContent: {
          principalId: "uid-123",
          attributes: {
            email: "ada@example.com",
            emailVerified: true,
            signInProvider: "password",
            customClaims: { role: "support-agent" },
          },
        },
      },
    });
    expect(JSON.stringify(body)).not.toContain(idToken);
  });

  it("answers 401 for a missing credential", async () => {
    const server = await startServer({
      verifyIdToken: async () => verifiedClaims,
    });

    const response = await callWhoami(server);
    await response.arrayBuffer();

    expect(response.status).toBe(401);
  });

  it("answers 401 for a credential the verifier rejects", async () => {
    const server = await startServer({ verifyIdToken: async () => null });

    const response = await callWhoami(server, `Bearer ${idToken}`);
    await response.arrayBuffer();

    expect(response.status).toBe(401);
  });

  it("answers 500 for a verification infrastructure failure", async () => {
    const server = await startServer({
      verifyIdToken: async () => {
        throw new Error("verification backend unavailable");
      },
    });

    const response = await callWhoami(server, `Bearer ${idToken}`);
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).not.toContain(idToken);
    expect(text).not.toContain("verification backend unavailable");
  });
});
