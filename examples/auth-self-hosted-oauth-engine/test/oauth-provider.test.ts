import { exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";

import {
  createOAuthProviderConfiguration,
  formatOAuthRegistrationError,
} from "../src/oauth/oauth-provider.js";

async function testConfiguration() {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const key = await exportJWK(privateKey);
  Object.assign(key, { alg: "ES256", kid: "test-signing-key", use: "sig" });
  return createOAuthProviderConfiguration({
    secrets: {
      cookieKeys: ["test-cookie-key-with-at-least-32-characters"],
      jwks: { keys: [key] },
    },
    server: {
      issuer: "https://mcp.example.com",
      resource: "https://mcp.example.com/mcp",
      host: "127.0.0.1",
      port: 3001,
      allowedHosts: ["mcp.example.com"],
    },
    users: {
      async findAccount() {
        return null;
      },
    },
  });
}

describe("OAuth client registration", () => {
  it("keeps CIMD disabled until an SSRF-resistant fetch policy exists", async () => {
    const configuration = await testConfiguration();

    expect(configuration.features).toMatchObject({
      clientIdMetadataDocument: { enabled: false },
    });
  });

  it("defaults DCR clients to confidential ES256 metadata", async () => {
    const configuration = await testConfiguration();

    expect(configuration.clientDefaults).toMatchObject({
      id_token_signed_response_alg: "ES256",
      token_endpoint_auth_method: "client_secret_basic",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  });

  it("formats registration failures without leaking submitted secrets", () => {
    const diagnostic = formatOAuthRegistrationError(
      { method: "POST", path: "/reg" },
      {
        error: "invalid_client_metadata",
        error_description: "client_secret super-secret-value is invalid",
        statusCode: 400,
      },
    );

    expect(diagnostic).toBe(
      "OAuth client registration failed: method=POST path=/reg status=400 code=invalid_client_metadata.\n",
    );
    expect(diagnostic).not.toContain("super-secret-value");
  });
});
