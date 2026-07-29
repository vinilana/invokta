import { describe, expect, it, vi } from "vitest";

import { createRemoteInstallDescriptor } from "../src/remote-install-source.js";

function expectRemoteInvalid(operation: () => unknown): void {
  let error: unknown;
  try {
    operation();
  } catch (caught) {
    error = caught;
  }
  expect(error).toMatchObject({ code: "REMOTE_INVALID" });
}

describe("remote MCP installation source", () => {
  it("normalizes an HTTPS descriptor using environment references only", () => {
    const fetchBefore = globalThis.fetch;
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;
    try {
      const descriptor = createRemoteInstallDescriptor({
        serverName: "support_api",
        url: "https://support.example.com/mcp",
        bearerTokenEnvironment: "SUPPORT_BEARER_TOKEN",
        headerEnvironment: [
          "X-Tenant=SUPPORT_TENANT",
          "X-Api-Key=SUPPORT_API_KEY",
        ],
      });

      expect(descriptor).toEqual({
        id: "remote-support-api",
        version: "remote",
        title: "support_api",
        description: "Remote support_api MCP server.",
        capabilityIds: ["remote.support_api"],
        server: {
          name: "support_api",
          transport: {
            type: "streamable-http",
            url: "https://support.example.com/mcp",
            authentication: {
              type: "bearer-env",
              variable: "SUPPORT_BEARER_TOKEN",
            },
            headersFromEnv: {
              "x-api-key": "SUPPORT_API_KEY",
              "x-tenant": "SUPPORT_TENANT",
            },
          },
        },
      });
      expect(Object.isFrozen(descriptor.server.transport)).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = fetchBefore;
    }
  });

  it.each([
    [
      "an invalid server name",
      { serverName: "Support API", url: "https://example.com/mcp" },
    ],
    [
      "credentials in the URL",
      { serverName: "api", url: "https://user:secret@example.com/mcp" },
    ],
    [
      "a noncanonical path",
      { serverName: "api", url: "https://example.com/mcp/" },
    ],
    ["a query", { serverName: "api", url: "https://example.com/mcp?token=x" }],
    [
      "insecure remote HTTP",
      { serverName: "api", url: "http://example.com/mcp" },
    ],
    ["localhost HTTP", { serverName: "api", url: "http://localhost/mcp" }],
    [
      "an invalid bearer environment name",
      {
        serverName: "api",
        url: "https://example.com/mcp",
        bearerTokenEnvironment: "token",
      },
    ],
    [
      "a literal header value",
      {
        serverName: "api",
        url: "https://example.com/mcp",
        headerEnvironment: ["X-Api-Key=literal-secret"],
      },
    ],
    [
      "a reserved header",
      {
        serverName: "api",
        url: "https://example.com/mcp",
        headerEnvironment: ["Host=SUPPORT_HOST"],
      },
    ],
    [
      "duplicate headers",
      {
        serverName: "api",
        url: "https://example.com/mcp",
        headerEnvironment: ["X-Key=FIRST", "x-key=SECOND"],
      },
    ],
  ])("rejects %s", (_label, input) => {
    expectRemoteInvalid(() => createRemoteInstallDescriptor(input));
  });

  it.each(["http://127.0.0.1/mcp", "http://[::1]/mcp"])(
    "accepts the explicit insecure loopback exception %s",
    (url) => {
      expect(
        createRemoteInstallDescriptor({ serverName: "local-api", url }).server
          .transport,
      ).toMatchObject({ url });
    },
  );
});
