import { describe, expect, it, vi } from "vitest";

import {
  apiKeyAuthenticator,
  chainAuthenticators,
  type GatewayAuthenticationRequest,
  hashApiKey,
} from "../src/index.js";

function request(
  headers: Record<string, string>,
): GatewayAuthenticationRequest {
  const values = new Headers(headers);
  return {
    path: "/mcp",
    method: "POST",
    headers: {
      get: (name) => values.get(name),
      has: (name) => values.has(name),
    },
    signal: new AbortController().signal,
  };
}

describe("hashApiKey", () => {
  it("returns the lowercase SHA-256 digest of the key", async () => {
    await expect(hashApiKey("secret")).resolves.toBe(
      "2bb80d537b1da3e38bd30361aa855686bde0eacd7162fef6a25fe97bf527a25b",
    );
  });
});

describe("apiKeyAuthenticator", () => {
  it("maps a configured key to its principal and rejects everything else", async () => {
    const authenticate = apiKeyAuthenticator({
      keys: [
        {
          id: "ci-bot",
          sha256: await hashApiKey("ci-secret"),
          attributes: { scopes: ["support:read"] },
        },
        { id: "ops-bot", sha256: await hashApiKey("ops-secret") },
      ],
    });

    await expect(
      authenticate(request({ "x-api-key": "ci-secret" })),
    ).resolves.toEqual({
      id: "ci-bot",
      attributes: { scopes: ["support:read"] },
    });
    await expect(
      authenticate(request({ "x-api-key": "ops-secret" })),
    ).resolves.toEqual({ id: "ops-bot" });
    await expect(
      authenticate(request({ "x-api-key": "wrong" })),
    ).resolves.toBeNull();
    await expect(authenticate(request({}))).resolves.toBeNull();
    await expect(
      authenticate(request({ "x-api-key": "k".repeat(1_025) })),
    ).resolves.toBeNull();
  });

  it("reads a configured header", async () => {
    const authenticate = apiKeyAuthenticator({
      header: "x-gateway-key",
      keys: [{ id: "bot", sha256: await hashApiKey("value") }],
    });

    await expect(
      authenticate(request({ "x-gateway-key": "value" })),
    ).resolves.toEqual({ id: "bot" });
    await expect(
      authenticate(request({ "x-api-key": "value" })),
    ).resolves.toBeNull();
  });

  it("rejects invalid configuration before serving", () => {
    expect(() => apiKeyAuthenticator({ keys: [] })).toThrow(TypeError);
    expect(() =>
      apiKeyAuthenticator({ keys: [{ id: "bot", sha256: "not-a-digest" }] }),
    ).toThrow(TypeError);
    expect(() =>
      apiKeyAuthenticator({
        keys: [
          { id: "bot", sha256: "a".repeat(64) },
          { id: "bot", sha256: "b".repeat(64) },
        ],
      }),
    ).toThrow(TypeError);
    expect(() =>
      apiKeyAuthenticator({
        header: "bad header",
        keys: [{ id: "bot", sha256: "a".repeat(64) }],
      }),
    ).toThrow(TypeError);
  });
});

describe("chainAuthenticators", () => {
  it("returns the first principal and tries the methods in order", async () => {
    const never = vi.fn(async () => ({ id: "never" }));
    const authenticate = chainAuthenticators(
      async () => null,
      () => ({ id: "second" }),
      never,
    );

    await expect(authenticate(request({}))).resolves.toEqual({ id: "second" });
    expect(never).not.toHaveBeenCalled();
  });

  it("returns null when no method authenticates and propagates failures", async () => {
    await expect(
      chainAuthenticators(
        () => null,
        async () => null,
      )(request({})),
    ).resolves.toBeNull();
    await expect(
      chainAuthenticators(
        () => null,
        () => {
          throw new Error("JWKS unavailable");
        },
      )(request({})),
    ).rejects.toThrow("JWKS unavailable");
    expect(() => chainAuthenticators()).toThrow(TypeError);
  });
});
