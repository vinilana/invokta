import { createHash, randomBytes } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { startOAuthEngine } from "./fixtures/oauth-engine.mjs";
import {
  startOAuthProvider,
  verifyAccessToken,
} from "./fixtures/oauth-provider.mjs";

/**
 * Drives the OAuth fixtures with plain `fetch` only. Nothing here goes through
 * the MCP client, so the fixtures are proven independently of the client's
 * trust rules and of the devtools UI.
 *
 * This test is `.mjs` because the fixtures are: `tsconfig.test.json` typechecks
 * `test/**\/*.ts` with `allowJs` off, so a `.ts` test cannot import them.
 */

const REDIRECT_URI = "http://127.0.0.1:4100/oauth/callback";
const started = [];

afterEach(async () => {
  await Promise.allSettled(started.splice(0).map((handle) => handle.close()));
});

async function startProvider(options = {}) {
  const provider = await startOAuthProvider(options);
  started.push(provider);
  return provider;
}

async function startEngine(provider) {
  const engine = await startOAuthEngine({
    authorizationServerUrl: provider.url,
    signingKey: provider.signingKey,
  });
  started.push(engine);
  return engine.url;
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256")
      .update(verifier, "ascii")
      .digest("base64url"),
  };
}

async function register(providerUrl) {
  const response = await fetch(`${providerUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      client_name: "Invokta devtools",
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json()).client_id;
}

function authorize(providerUrl, params) {
  const url = new URL(`${providerUrl}/authorize`);
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, value);
  }
  return fetch(url, { redirect: "manual" });
}

function exchange(providerUrl, params) {
  return fetch(`${providerUrl}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
}

/** Requests one authorization code the way the MCP client would. */
async function requestCode(provider, { clientId, challenge, resource }) {
  const response = await authorize(provider.url, {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: randomBytes(32).toString("base64url"),
    resource,
  });
  expect(response.status).toBe(302);
  const code = new URL(response.headers.get("location") ?? "").searchParams.get(
    "code",
  );
  expect(code).not.toBeNull();
  return code;
}

async function issueAccessToken(provider, resource) {
  const clientId = await register(provider.url);
  const { verifier, challenge } = pkce();
  const code = await requestCode(provider, { clientId, challenge, resource });
  const response = await exchange(provider.url, {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    resource,
  });
  expect(response.status).toBe(200);
  return (await response.json()).access_token;
}

function callWhoami(engineUrl, token) {
  return fetch(engineUrl, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "fixture_whoami", arguments: { marker: "oauth" } },
    }),
  });
}

describe("OAuth provider fixture", () => {
  it("publishes RFC 8414 metadata whose issuer is its own origin", async () => {
    const provider = await startProvider();

    const response = await fetch(
      `${provider.url}/.well-known/oauth-authorization-server`,
    );

    expect(response.status).toBe(200);
    const metadata = await response.json();
    // The MCP client rejects metadata whose issuer is not exactly the
    // authorization server URL it discovered.
    expect(metadata.issuer).toBe(provider.url);
    expect(metadata).toMatchObject({
      authorization_endpoint: `${provider.url}/authorize`,
      token_endpoint: `${provider.url}/token`,
      registration_endpoint: `${provider.url}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
    });
  });

  it("registers a public client and rejects a malformed registration", async () => {
    const provider = await startProvider();

    const response = await fetch(`${provider.url}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT_URI] }),
    });

    expect(response.status).toBe(201);
    const registration = await response.json();
    expect(registration.client_id).toMatch(/^client-[\w-]+$/u);
    expect(registration.client_secret).toBeUndefined();
    expect(registration.redirect_uris).toEqual([REDIRECT_URI]);

    const malformed = await fetch(`${provider.url}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: "not-an-array" }),
    });
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error).toBe("invalid_redirect_uri");
  });

  it("redirects an authorization request back with a code and the original state", async () => {
    const provider = await startProvider();
    const clientId = await register(provider.url);
    const { challenge } = pkce();
    const state = "abcdefghijklmnopqrstuvwxyz0123456789_ABCDEF";

    const response = await authorize(provider.url, {
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      resource: "http://127.0.0.1:4200/mcp",
    });

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT_URI);
    expect(location.searchParams.get("state")).toBe(state);
    expect(location.searchParams.get("code")).not.toBeNull();
    expect(location.searchParams.get("error")).toBeNull();
  });

  it("refuses to redirect to an unregistered redirect_uri", async () => {
    const provider = await startProvider();
    const clientId = await register(provider.url);
    const { challenge } = pkce();

    const response = await authorize(provider.url, {
      response_type: "code",
      client_id: clientId,
      redirect_uri: "http://127.0.0.1:4100/stolen",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "abcdefghijklmnopqrstuvwxyz0123456789_ABCDEF",
      resource: "http://127.0.0.1:4200/mcp",
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    expect((await response.json()).error).toBe("invalid_request");
  });

  it("redirects a malformed authorization request back as an OAuth error", async () => {
    const provider = await startProvider();
    const clientId = await register(provider.url);
    const { challenge } = pkce();
    const state = "abcdefghijklmnopqrstuvwxyz0123456789_ABCDEF";

    const response = await authorize(provider.url, {
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: "plain",
      state,
      resource: "http://127.0.0.1:4200/mcp",
    });

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("error")).toBe("invalid_request");
    expect(location.searchParams.get("state")).toBe(state);
    expect(location.searchParams.get("code")).toBeNull();
  });

  it("rejects a wrong PKCE verifier and accepts the right one", async () => {
    const provider = await startProvider();
    const clientId = await register(provider.url);
    const resource = "http://127.0.0.1:4200/mcp";
    const { verifier, challenge } = pkce();

    // Each code allows exactly one exchange attempt, so the rejected attempt
    // and the accepted one each need their own authorization.
    const rejectedCode = await requestCode(provider, {
      clientId,
      challenge,
      resource,
    });
    const rejected = await exchange(provider.url, {
      grant_type: "authorization_code",
      code: rejectedCode,
      code_verifier: pkce().verifier,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      resource,
    });
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).error).toBe("invalid_grant");

    const acceptedCode = await requestCode(provider, {
      clientId,
      challenge,
      resource,
    });
    const accepted = await exchange(provider.url, {
      grant_type: "authorization_code",
      code: acceptedCode,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      resource,
    });
    expect(accepted.status).toBe(200);
    const tokens = await accepted.json();
    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 300 });

    // The token is audience-bound to the resource the code was issued for.
    expect(
      verifyAccessToken(tokens.access_token, {
        signingKey: provider.signingKey,
        audience: resource,
      }),
    ).toMatchObject({ sub: "subject", aud: resource });
    expect(
      verifyAccessToken(tokens.access_token, {
        signingKey: provider.signingKey,
        audience: "http://127.0.0.1:4201/mcp",
      }),
    ).toBeNull();

    const replayed = await exchange(provider.url, {
      grant_type: "authorization_code",
      code: acceptedCode,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      resource,
    });
    expect(replayed.status).toBe(400);
    expect((await replayed.json()).error).toBe("invalid_grant");
  });
});

describe("OAuth engine fixture", () => {
  it("answers an unauthenticated call with a resource metadata challenge", async () => {
    const provider = await startProvider();
    const engineUrl = await startEngine(provider);

    const response = await callWhoami(engineUrl);

    expect(response.status).toBe(401);
    const challenge = response.headers.get("www-authenticate") ?? "";
    const metadataUrl = /resource_metadata="([^"]+)"/u.exec(challenge)?.[1];
    expect(metadataUrl).toBeDefined();

    // The advertised document is what points a client at the provider.
    const metadata = await (await fetch(metadataUrl)).json();
    expect(metadata).toMatchObject({
      resource: engineUrl,
      authorization_servers: [provider.url],
    });
  });

  it("accepts a token from its provider and reports the mapped principal", async () => {
    const provider = await startProvider();
    const engineUrl = await startEngine(provider);

    const response = await callWhoami(
      engineUrl,
      await issueAccessToken(provider, engineUrl),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: {
        structuredContent: {
          marker: "oauth",
          source: "mcp-http",
          principalId: "oauth:subject",
        },
      },
    });
  });

  it("derives the principal from the token subject", async () => {
    const provider = await startProvider({ subject: "alice" });
    const engineUrl = await startEngine(provider);

    const response = await callWhoami(
      engineUrl,
      await issueAccessToken(provider, engineUrl),
    );

    expect(await response.json()).toMatchObject({
      result: { structuredContent: { principalId: "oauth:alice" } },
    });
  });

  it("rejects a token issued for another audience", async () => {
    const provider = await startProvider();
    const engineUrl = await startEngine(provider);

    const response = await callWhoami(
      engineUrl,
      await issueAccessToken(provider, "http://127.0.0.1:4200/mcp"),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      "resource_metadata=",
    );
  });
});
