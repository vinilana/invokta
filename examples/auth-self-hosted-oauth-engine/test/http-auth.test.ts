import { describe, expect, it } from "vitest";
import type { McpHttpAuthenticationRequest } from "@invokta/mcp";

import {
  createBearerHttpAuth,
  createOAuthHttpAuth,
  readHttpAuthenticationConfiguration,
} from "../src/http-auth.js";

function authenticationRequest(
  authorization?: string,
): McpHttpAuthenticationRequest {
  const headers = new Headers(
    authorization === undefined ? {} : { authorization },
  );
  return {
    path: "/mcp",
    method: "POST",
    headers,
    signal: new AbortController().signal,
  };
}

describe("HTTP bearer authentication", () => {
  it("returns the configured principal for the exact bearer token", () => {
    const auth = createBearerHttpAuth({
      token: "a-secure-token-with-enough-entropy",
      principalId: "person:ada",
    });
    const request = authenticationRequest(
      "Bearer a-secure-token-with-enough-entropy",
    );

    expect(auth.authenticate(request)).toEqual({ id: "person:ada" });
  });

  it("rejects missing, malformed, and incorrect credentials", () => {
    const auth = createBearerHttpAuth({
      token: "a-secure-token-with-enough-entropy",
      principalId: "person:ada",
    });

    expect(auth.authenticate(authenticationRequest())).toBeNull();
    expect(
      auth.authenticate(
        authenticationRequest("Basic a-secure-token-with-enough-entropy"),
      ),
    ).toBeNull();
    expect(
      auth.authenticate(authenticationRequest("Bearer incorrect-token")),
    ).toBeNull();
  });

  it("fails closed when server authentication is not configured", () => {
    const auth = createBearerHttpAuth({ token: "", principalId: "" });
    const request = authenticationRequest("Bearer anything");

    expect(auth.authenticate(request)).toBeNull();
  });
});

describe("HTTP OAuth authentication", () => {
  it("uses OAuth by default and derives MCP resource metadata", () => {
    expect(
      readHttpAuthenticationConfiguration({
        APP_PUBLIC_URL: "https://mcp.example.com",
      }),
    ).toEqual({
      mode: "oauth",
      issuer: "https://mcp.example.com",
      jwksUrl: "https://mcp.example.com/jwks",
      resource: "https://mcp.example.com/mcp",
      scopes: ["mcp:tools"],
    });
  });

  it("allows an explicit internal JWKS URL without changing the public issuer", () => {
    expect(
      readHttpAuthenticationConfiguration({
        APP_PUBLIC_URL: "https://mcp.example.com",
        INVOKTA_OAUTH_JWKS_URL: "http://auth:3001/jwks",
      }),
    ).toMatchObject({
      issuer: "https://mcp.example.com",
      jwksUrl: "http://auth:3001/jwks",
      resource: "https://mcp.example.com/mcp",
    });
  });

  it("maps a valid OAuth subject and scopes to an engine principal", async () => {
    const auth = createOAuthHttpAuth({
      issuer: "https://mcp.example.com",
      resource: "https://mcp.example.com/mcp",
      scopes: ["mcp:tools"],
      verifier: {
        async verify(token) {
          if (token !== "valid-access-token") return null;
          return {
            subject: "person:ada",
            clientId: "https://client.example.com/metadata.json",
            scopes: ["mcp:tools", "offline_access"],
          };
        },
      },
    });

    await expect(
      auth.authenticate(authenticationRequest("Bearer valid-access-token")),
    ).resolves.toEqual({
      id: "person:ada",
      attributes: {
        clientId: "https://client.example.com/metadata.json",
        scopes: ["mcp:tools", "offline_access"],
      },
    });
    expect(auth.resourceMetadata).toEqual({
      resource: "https://mcp.example.com/mcp",
      authorizationServers: ["https://mcp.example.com"],
      scopesSupported: ["mcp:tools"],
    });
    expect(auth.challengeScopes).toEqual(["mcp:tools"]);
  });

  it("rejects invalid tokens and tokens missing the required scope", async () => {
    const auth = createOAuthHttpAuth({
      issuer: "https://mcp.example.com",
      resource: "https://mcp.example.com/mcp",
      scopes: ["mcp:tools"],
      verifier: {
        async verify(token) {
          if (token === "wrong-scope") {
            return { subject: "person:ada", scopes: ["profile"] };
          }
          return null;
        },
      },
    });

    await expect(
      auth.authenticate(authenticationRequest()),
    ).resolves.toBeNull();
    await expect(
      auth.authenticate(authenticationRequest("Bearer invalid")),
    ).resolves.toBeNull();
    await expect(
      auth.authenticate(authenticationRequest("Bearer wrong-scope")),
    ).resolves.toBeNull();
  });

  it("requires an explicit opt-in for legacy static Bearer mode", () => {
    expect(() =>
      readHttpAuthenticationConfiguration({
        INVOKTA_HTTP_AUTH_MODE: "bearer",
        INVOKTA_HTTP_BEARER_TOKEN: "a-secure-token-with-enough-entropy",
        INVOKTA_HTTP_PRINCIPAL_ID: "person:ada",
      }),
    ).not.toThrow();
    expect(() => readHttpAuthenticationConfiguration({})).toThrow(
      /APP_PUBLIC_URL/,
    );
  });

  it("rejects insecure public OAuth URLs outside loopback development", () => {
    expect(() =>
      readHttpAuthenticationConfiguration({
        APP_PUBLIC_URL: "http://mcp.example.com",
      }),
    ).toThrow(/HTTPS/);
  });
});
