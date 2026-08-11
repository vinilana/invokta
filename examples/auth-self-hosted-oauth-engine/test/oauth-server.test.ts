import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "../src/oauth/password.js";
import { interactionContentSecurityPolicy } from "../src/oauth/interaction-server.js";
import {
  formatOAuthRequestCompletion,
  formatOAuthRequestFailure,
} from "../src/oauth/diagnostics.js";
import { readOAuthServerConfiguration } from "../src/oauth/server-config.js";

describe("self-hosted OAuth server", () => {
  it("derives the issuer and MCP resource from the public URL", () => {
    expect(
      readOAuthServerConfiguration({
        APP_PUBLIC_URL: "https://mcp.example.com",
      }),
    ).toEqual({
      issuer: "https://mcp.example.com",
      resource: "https://mcp.example.com/mcp",
      host: "127.0.0.1",
      port: 3001,
      allowedHosts: ["mcp.example.com", "auth", "localhost", "127.0.0.1"],
    });
  });

  it("hashes passwords with a unique salt and verifies them", async () => {
    const first = await hashPassword("a correct horse battery staple");
    const second = await hashPassword("a correct horse battery staple");

    expect(first).not.toBe(second);
    await expect(
      verifyPassword("a correct horse battery staple", first),
    ).resolves.toBe(true);
    await expect(verifyPassword("incorrect password", first)).resolves.toBe(
      false,
    );
  });

  it("refuses weak bootstrap passwords and insecure public URLs", async () => {
    await expect(hashPassword("too-short")).rejects.toThrow(/12 characters/);
    expect(() =>
      readOAuthServerConfiguration({
        APP_PUBLIC_URL: "http://mcp.example.com",
      }),
    ).toThrow(/HTTPS/);
  });

  it("allows the validated HTTPS OAuth callback redirect chain", () => {
    expect(
      interactionContentSecurityPolicy(
        "https://oauth-redirect.googleusercontent.com/r/client/callback",
      ),
    ).toContain("form-action 'self' https:;");
  });

  it("does not add unsafe callback schemes to the interaction policy", () => {
    expect(
      interactionContentSecurityPolicy("javascript:alert(document.domain)"),
    ).toContain("form-action 'self';");
  });

  it("formats OAuth request diagnostics without secrets or interaction IDs", () => {
    const completion = formatOAuthRequestCompletion({
      issuer: "https://mcp.example.com",
      location:
        "https://oauth-redirect.googleusercontent.com/r/callback?code=secret-code&state=secret-state",
      method: "GET",
      path: "/auth/secret-interaction-id",
      status: 303,
    });
    const failure = formatOAuthRequestFailure(
      {
        method: "POST",
        path: "/interaction/secret-interaction-id/consent",
      },
      { name: "SessionNotFound", message: "secret failure detail" },
    );

    expect(completion).toBe(
      "OAuth request completed: method=GET route=authorization status=303 redirect=https://oauth-redirect.googleusercontent.com.\n",
    );
    expect(failure).toBe(
      "OAuth request failed: method=POST route=interaction_consent status=500 code=SessionNotFound.\n",
    );
    expect(completion + failure).not.toMatch(/secret-/);
  });
});
