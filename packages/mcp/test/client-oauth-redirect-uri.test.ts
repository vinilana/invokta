import { describe, expect, it } from "vitest";

import { matchesMcpOAuthAuthorizationRedirectUri } from "../src/client.js";

describe("MCP OAuth authorization redirect URI validation", () => {
  it("accepts a matching redirect_uri", () => {
    const callback = "http://127.0.0.1:4100/oauth/callback";
    const url = new URL(
      `http://issuer.example.test/authorize?response_type=code&redirect_uri=${encodeURIComponent(callback)}&state=x`,
    );
    expect(matchesMcpOAuthAuthorizationRedirectUri(url, callback)).toBe(true);
  });

  it("rejects a mismatched redirect_uri", () => {
    const callback = "http://127.0.0.1:4100/oauth/callback";
    const url = new URL(
      "http://issuer.example.test/authorize?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A4110%2Foauth%2Fcallback&state=x",
    );
    expect(matchesMcpOAuthAuthorizationRedirectUri(url, callback)).toBe(false);
  });
});
