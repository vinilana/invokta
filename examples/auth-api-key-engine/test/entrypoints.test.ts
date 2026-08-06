import { afterEach, describe, expect, it, vi } from "vitest";

import { main as directMain } from "../src/direct.js";
import { hashApiKeySecret } from "../src/identity/verifier.js";
import { main as mcpHttpMain } from "../src/mcp-http.js";

const secret = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY";
const apiKey = `svc_reports_2026a.${secret}`;
const keySet = JSON.stringify([
  {
    keyId: "svc_reports_2026a",
    secretHash: hashApiKeySecret(secret),
    serviceName: "reports-worker",
    scopes: ["identity:read"],
  },
]);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("direct entrypoint", () => {
  it("verifies the configured key and prints only the capability result", async () => {
    vi.stubEnv("API_KEY_ENGINE_KEYS", keySet);
    vi.stubEnv("API_KEY_ENGINE_CREDENTIAL", apiKey);
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await directMain();

    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0]?.[0]).toBe(
      `${JSON.stringify({
        principalId: "reports-worker",
        attributes: { keyId: "svc_reports_2026a", scopes: ["identity:read"] },
      })}\n`,
    );
  });

  it("fails without echoing the rejected credential", async () => {
    const rejected = "x".repeat(43);
    vi.stubEnv("API_KEY_ENGINE_KEYS", keySet);
    vi.stubEnv("API_KEY_ENGINE_CREDENTIAL", `svc_reports_2026a.${rejected}`);

    const failure = await directMain().then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain(rejected);
  });
});

describe("mcp http entrypoint", () => {
  it("requires the key set before it listens", async () => {
    vi.stubEnv("API_KEY_ENGINE_KEYS", "");

    await expect(mcpHttpMain()).rejects.toThrow(/API_KEY_ENGINE_KEYS/u);
  });

  it("listens on the configured port with the environment key set", async () => {
    vi.stubEnv("API_KEY_ENGINE_KEYS", keySet);
    vi.stubEnv("PORT", "0");

    const server = await mcpHttpMain();
    try {
      expect(server.address().host).toBe("127.0.0.1");
      expect(server.address().port).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });

  it("rejects a port outside the valid range", async () => {
    vi.stubEnv("API_KEY_ENGINE_KEYS", keySet);
    vi.stubEnv("PORT", "not-a-port");

    await expect(mcpHttpMain()).rejects.toThrow(/PORT/u);
  });
});
