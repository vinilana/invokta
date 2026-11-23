import { describe, expect, it, vi } from "vitest";

import { beginMcpOAuthAuthorization, inspectMcpOAuth } from "../src/index.js";

describe("McpOAuthClientTarget descriptor validation", () => {
  it("rejects empty, whitespace, control, or oversized clientId values", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const base = {
      transport: "http" as const,
      url: "http://127.0.0.1:3000/mcp",
    };
    const options = {
      redirectUrl: "http://127.0.0.1:4100/oauth/callback",
      state: "abcdefghijklmnopqrstuvwxyz0123456789_ABCDEF",
    };
    for (const clientId of ["", "  ", "\x07", "x".repeat(257)]) {
      await expect(
        beginMcpOAuthAuthorization(
          {
            ...base,
            authentication: {
              type: "oauth",
              clientId,
              issuer: "http://127.0.0.1:3000",
            },
          },
          options,
        ),
      ).rejects.toMatchObject({ code: "INVALID_TARGET" });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects redirectUris without clientId and unknown extra keys", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(
      beginMcpOAuthAuthorization(
        {
          transport: "http",
          url: "http://127.0.0.1:3000/mcp",
          authentication: {
            type: "oauth",
            redirectUris: ["http://127.0.0.1:4100/oauth/callback"],
          },
        },
        {
          redirectUrl: "http://127.0.0.1:4100/oauth/callback",
          state: "abcdefghijklmnopqrstuvwxyz0123456789_ABCDEF",
        },
      ),
    ).rejects.toMatchObject({ code: "INVALID_TARGET" });
    await expect(
      beginMcpOAuthAuthorization(
        {
          transport: "http",
          url: "http://127.0.0.1:3000/mcp",
          authentication: {
            type: "oauth",
            clientId: "client",
            issuer: "http://127.0.0.1:3000",
            clientSecret: "secret",
          } as unknown as {
            type: "oauth";
            clientId: string;
            issuer: string;
            clientSecret: string;
          },
        },
        {
          redirectUrl: "http://127.0.0.1:4100/oauth/callback",
          state: "abcdefghijklmnopqrstuvwxyz0123456789_ABCDEF",
        },
      ),
    ).rejects.toMatchObject({ code: "INVALID_TARGET" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects invalid redirectUris and issuer values", async () => {
    const options = {
      redirectUrl: "http://127.0.0.1:4100/oauth/callback",
      state: "abcdefghijklmnopqrstuvwxyz0123456789_ABCDEF",
    };
    await expect(
      inspectMcpOAuth({
        transport: "http",
        url: "http://127.0.0.1:3000/mcp",
        authentication: {
          type: "oauth",
          clientId: "client",
          issuer: "http://127.0.0.1:3000",
          redirectUris: ["https://external.example.test/callback"],
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_TARGET" });
    await expect(
      inspectMcpOAuth({
        transport: "http",
        url: "http://127.0.0.1:3000/mcp",
        authentication: {
          type: "oauth",
          clientId: "client",
          issuer: "ftp://issuer.example.test",
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_TARGET" });
    await expect(
      beginMcpOAuthAuthorization(
        {
          transport: "http",
          url: "http://127.0.0.1:3000/mcp",
          authentication: {
            type: "oauth",
            clientId: "client",
          },
        },
        options,
      ),
    ).rejects.toMatchObject({ code: "INVALID_TARGET" });
    void options;
  });
});
