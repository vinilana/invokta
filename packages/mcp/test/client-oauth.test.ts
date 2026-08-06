import {
  createServer,
  type IncomingMessage,
  type Server as NodeHttpServer,
} from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  beginMcpOAuthAuthorization,
  type McpClientConnection,
  type McpOAuthAuthorization,
} from "../src/index.js";

const servers: NodeHttpServer[] = [];
const authorizations: McpOAuthAuthorization[] = [];
const connections: McpClientConnection[] = [];

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(
    connections.splice(0).map((connection) => connection.close()),
  );
  await Promise.allSettled(
    authorizations.splice(0).map((authorization) => authorization.close()),
  );
  await Promise.allSettled(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function startOAuthFixture(
  options: {
    readonly authorizationEndpoint?: (origin: string) => string;
    readonly issuer?: string;
    readonly registrationError?: "invalid_client";
    readonly rejectTools?: boolean;
    readonly resourceMetadataFailure?:
      | "bad-request"
      | "invalid-utf8"
      | "malformed-json"
      | "oversized"
      | "path-not-found"
      | "rate-limited"
      | "redirect"
      | "schema-invalid"
      | "server-error";
    readonly tokenError?: "invalid_grant";
    readonly tokenStarted?: () => void;
    readonly waitForToken?: Promise<void>;
  } = {},
) {
  const observed = {
    authorizationEndpointRequests: 0,
    authorizationMetadataRequests: 0,
    registrationBodies: [] as string[],
    tokenBodies: [] as string[],
    initialized: 0,
    toolListRequests: 0,
  };
  let origin = "";
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", origin);
    if (request.method === "GET" && url.pathname === "/authorize") {
      observed.authorizationEndpointRequests += 1;
      response.writeHead(500).end();
      return;
    }
    if (
      request.method === "GET" &&
      (url.pathname === "/.well-known/oauth-protected-resource/mcp" ||
        url.pathname === "/.well-known/oauth-protected-resource")
    ) {
      if (
        options.resourceMetadataFailure === "path-not-found" &&
        url.pathname === "/.well-known/oauth-protected-resource/mcp"
      ) {
        response.writeHead(404).end();
        return;
      }
      if (options.resourceMetadataFailure === "redirect") {
        response.writeHead(302, { location: `${origin}/legacy` }).end();
        return;
      }
      if (options.resourceMetadataFailure === "bad-request") {
        response.writeHead(400).end();
        return;
      }
      if (options.resourceMetadataFailure === "rate-limited") {
        response.writeHead(429).end();
        return;
      }
      if (options.resourceMetadataFailure === "oversized") {
        response
          .writeHead(200, {
            "content-length": String(10 * 1024 * 1024 + 1),
            "content-type": "application/json",
          })
          .end("{}");
        return;
      }
      if (options.resourceMetadataFailure === "invalid-utf8") {
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(Buffer.from([0xc3, 0x28]));
        return;
      }
      if (options.resourceMetadataFailure === "malformed-json") {
        response
          .writeHead(200, { "content-type": "application/json" })
          .end("{");
        return;
      }
      if (options.resourceMetadataFailure === "schema-invalid") {
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            resource: `${origin}/mcp`,
            authorization_servers: "not-an-array",
          }),
        );
        return;
      }
      if (options.resourceMetadataFailure === "server-error") {
        response.writeHead(503).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
          scopes_supported: ["tools:read"],
        }),
      );
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname === "/.well-known/oauth-authorization-server"
    ) {
      observed.authorizationMetadataRequests += 1;
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          issuer: options.issuer ?? origin,
          authorization_endpoint:
            options.authorizationEndpoint?.(origin) ?? `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
        }),
      );
      return;
    }
    if (request.method === "POST" && url.pathname === "/register") {
      const body = await requestBody(request);
      observed.registrationBodies.push(body);
      if (options.registrationError !== undefined) {
        response
          .writeHead(400, { "content-type": "application/json" })
          .end(JSON.stringify({ error: options.registrationError }));
        return;
      }
      const metadata = JSON.parse(body) as Record<string, unknown>;
      response
        .writeHead(201, { "content-type": "application/json" })
        .end(JSON.stringify({ ...metadata, client_id: "invokta-test-client" }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/token") {
      observed.tokenBodies.push(await requestBody(request));
      options.tokenStarted?.();
      await options.waitForToken;
      if (options.tokenError !== undefined) {
        response
          .writeHead(400, { "content-type": "application/json" })
          .end(JSON.stringify({ error: options.tokenError }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          access_token: "oauth-access-canary",
          token_type: "Bearer",
          expires_in: 300,
          refresh_token: "must-not-be-refreshed",
        }),
      );
      return;
    }
    if (request.method === "POST" && url.pathname === "/mcp") {
      if (request.headers.authorization !== "Bearer oauth-access-canary") {
        await requestBody(request);
        response.writeHead(401, {
          "www-authenticate":
            options.resourceMetadataFailure === "path-not-found"
              ? "Bearer"
              : `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
        });
        response.end();
        return;
      }
      const message = JSON.parse(await requestBody(request)) as Record<
        string,
        unknown
      >;
      if (message.method === "initialize") {
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {} },
              serverInfo: { name: "oauth-fixture", version: "1.0.0" },
            },
          }),
        );
        return;
      }
      if (message.method === "notifications/initialized") {
        observed.initialized += 1;
        response.writeHead(202).end();
        return;
      }
      if (message.method === "tools/list") {
        observed.toolListRequests += 1;
        if (options.rejectTools === true) {
          response.writeHead(401).end();
          return;
        }
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { tools: [] },
          }),
        );
        return;
      }
    }
    response.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The OAuth fixture did not bind.");
  }
  origin = `http://127.0.0.1:${String(address.port)}`;
  return { url: `${origin}/mcp`, observed };
}

describe("plain MCP OAuth client facade", () => {
  it("discovers, registers, authorizes with PKCE, and returns a plain connection", async () => {
    const fixture = await startOAuthFixture();
    const state = "abcdefghijklmnopqrstuvwxyz0123456789_ABCDEF";
    const redirectUrl = "http://127.0.0.1:4100/oauth/callback";

    const authorization = await beginMcpOAuthAuthorization(
      {
        transport: "http",
        url: fixture.url,
        authentication: { type: "oauth" },
      },
      { redirectUrl, state },
    );
    authorizations.push(authorization);

    const authorizationUrl = new URL(authorization.authorizationUrl);
    expect(authorizationUrl.pathname).toBe("/authorize");
    expect(authorizationUrl.searchParams.get("response_type")).toBe("code");
    expect(authorizationUrl.searchParams.get("state")).toBe(state);
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(redirectUrl);
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(authorizationUrl.searchParams.get("code_challenge")).not.toBeNull();
    expect(fixture.observed.authorizationEndpointRequests).toBe(0);

    const registration = JSON.parse(
      fixture.observed.registrationBodies[0] ?? "{}",
    ) as Record<string, unknown>;
    expect(registration).toMatchObject({
      redirect_uris: [redirectUrl],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    });

    const connection = await authorization.finish("one-time-code");
    connections.push(connection);
    expect(connection.server).toMatchObject({
      name: "oauth-fixture",
      version: "1.0.0",
      protocolVersion: "2025-11-25",
    });
    await expect(connection.listTools()).resolves.toEqual({ tools: [] });
    expect(fixture.observed.initialized).toBe(1);
    const tokenRequest = new URLSearchParams(
      fixture.observed.tokenBodies[0] ?? "",
    );
    expect(tokenRequest.get("code")).toBe("one-time-code");
    expect(tokenRequest.get("code_verifier")).not.toBeNull();
    expect(tokenRequest.get("redirect_uri")).toBe(redirectUrl);

    await expect(authorization.finish("replayed-code")).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
    });
  });

  it("does not refresh or replay a connected operation after authentication fails", async () => {
    const fixture = await startOAuthFixture({ rejectTools: true });
    const authorization = await beginMcpOAuthAuthorization(
      {
        transport: "http",
        url: fixture.url,
        authentication: { type: "oauth" },
      },
      {
        redirectUrl: "http://127.0.0.1:4100/oauth/callback",
        state: "abcdefghijklmnopqrstuvwxyz0123456789_ABCDEF",
      },
    );
    authorizations.push(authorization);
    const connection = await authorization.finish("one-time-code");
    connections.push(connection);

    await expect(connection.listTools()).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
    });
    expect(fixture.observed.toolListRequests).toBe(1);
    expect(fixture.observed.tokenBodies).toHaveLength(1);
  });

  it("does not retry dynamic registration or a single-use code after OAuth errors", async () => {
    const registrationFailure = await startOAuthFixture({
      registrationError: "invalid_client",
    });
    await expect(
      beginMcpOAuthAuthorization(
        {
          transport: "http",
          url: registrationFailure.url,
          authentication: { type: "oauth" },
        },
        {
          redirectUrl: "http://127.0.0.1:4100/oauth/callback",
          state: "abcdefghijklmnopqrstuvwxyz0123456789_ABCDEF",
        },
      ),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
    expect(registrationFailure.observed.registrationBodies).toHaveLength(1);

    const tokenFailure = await startOAuthFixture({
      tokenError: "invalid_grant",
    });
    const authorization = await beginMcpOAuthAuthorization(
      {
        transport: "http",
        url: tokenFailure.url,
        authentication: { type: "oauth" },
      },
      {
        redirectUrl: "http://127.0.0.1:4100/oauth/callback",
        state: "abcdefghijklmnopqrstuvwxyz0123456789_ABCDEF",
      },
    );
    authorizations.push(authorization);
    await expect(authorization.finish("single-use-code")).rejects.toMatchObject(
      { code: "AUTHENTICATION_FAILED" },
    );
    expect(tokenFailure.observed.tokenBodies).toHaveLength(1);
  });

  it("makes close a barrier for an in-flight token exchange", async () => {
    const tokenGate = deferred();
    const tokenStarted = deferred();
    const fixture = await startOAuthFixture({
      tokenStarted: tokenStarted.resolve,
      waitForToken: tokenGate.promise,
    });
    const authorization = await beginMcpOAuthAuthorization(
      {
        transport: "http",
        url: fixture.url,
        authentication: { type: "oauth" },
      },
      {
        redirectUrl: "http://127.0.0.1:4100/oauth/callback",
        state: "abcdefghijklmnopqrstuvwxyz0123456789_ABCDEF",
      },
    );
    authorizations.push(authorization);
    const finishing = authorization.finish("single-use-code");
    await tokenStarted.promise;

    await expect(authorization.close()).resolves.toBeUndefined();
    await expect(finishing).rejects.toMatchObject({ code: "CANCELLED" });
    tokenGate.resolve();
    await expect(authorization.finish("late-code")).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
    });
  });

  it("rejects authorization metadata whose issuer does not exactly match", async () => {
    const fixture = await startOAuthFixture({
      issuer: "https://mismatched-issuer.example.test",
    });

    await expect(
      beginMcpOAuthAuthorization(
        {
          transport: "http",
          url: fixture.url,
          authentication: { type: "oauth" },
        },
        {
          redirectUrl: "http://127.0.0.1:4100/oauth/callback",
          state: "abcdefghijklmnopqrstuvwxyz0123456789_ABCDEF",
        },
      ),
    ).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    expect(fixture.observed.registrationBodies).toHaveLength(0);
  });

  it("allows the standard path-aware 404 fallback to root resource metadata", async () => {
    const fixture = await startOAuthFixture({
      resourceMetadataFailure: "path-not-found",
    });
    const authorization = await beginMcpOAuthAuthorization(
      {
        transport: "http",
        url: fixture.url,
        authentication: { type: "oauth" },
      },
      {
        redirectUrl: "http://127.0.0.1:4100/oauth/callback",
        state: "abcdefghijklmnopqrstuvwxyz0123456789_ABCDEF",
      },
    );
    authorizations.push(authorization);

    expect(new URL(authorization.authorizationUrl).pathname).toBe("/authorize");
    expect(fixture.observed.authorizationMetadataRequests).toBe(1);
    expect(fixture.observed.registrationBodies).toHaveLength(1);
  });

  it.each([
    ["redirect", "CONNECTION_FAILED"],
    ["bad-request", "CONNECTION_FAILED"],
    ["rate-limited", "CONNECTION_FAILED"],
    ["oversized", "LIMIT_EXCEEDED"],
    ["invalid-utf8", "PROTOCOL_ERROR"],
    ["malformed-json", "PROTOCOL_ERROR"],
    ["schema-invalid", "PROTOCOL_ERROR"],
    ["server-error", "CONNECTION_FAILED"],
  ] as const)(
    "fails closed when protected-resource metadata has a terminal %s failure",
    async (resourceMetadataFailure, code) => {
      const fixture = await startOAuthFixture({ resourceMetadataFailure });

      await expect(
        beginMcpOAuthAuthorization(
          {
            transport: "http",
            url: fixture.url,
            authentication: { type: "oauth" },
          },
          {
            redirectUrl: "http://127.0.0.1:4100/oauth/callback",
            state: "abcdefghijklmnopqrstuvwxyz0123456789_ABCDEF",
          },
        ),
      ).rejects.toMatchObject({ code });
      expect(fixture.observed.registrationBodies).toHaveLength(0);
      expect(fixture.observed.authorizationMetadataRequests).toBe(0);
    },
  );

  it("accepts an 8,192-byte authorization URL and rejects the next byte", async () => {
    let padding = "";
    const fixture = await startOAuthFixture({
      authorizationEndpoint: (origin) =>
        `${origin}/authorize?padding=${padding}`,
    });
    const target = {
      transport: "http" as const,
      url: fixture.url,
      authentication: { type: "oauth" as const },
    };
    const options = {
      redirectUrl: "http://127.0.0.1:4100/oauth/callback",
      state: "abcdefghijklmnopqrstuvwxyz0123456789_ABCDEF",
    };
    const probe = await beginMcpOAuthAuthorization(target, options);
    authorizations.push(probe);
    padding = "x".repeat(
      8_192 - new TextEncoder().encode(probe.authorizationUrl).byteLength,
    );

    const exact = await beginMcpOAuthAuthorization(target, options);
    authorizations.push(exact);
    expect(new TextEncoder().encode(exact.authorizationUrl)).toHaveLength(
      8_192,
    );

    padding += "x";

    await expect(
      beginMcpOAuthAuthorization(target, options),
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  });

  it("rejects invalid OAuth descriptors before network I/O", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(
      beginMcpOAuthAuthorization(
        {
          transport: "http",
          url: "https://example.test/mcp",
          authentication: { type: "oauth" },
        },
        {
          redirectUrl: "https://external.example.test/callback",
          state: "short",
        },
      ),
    ).rejects.toMatchObject({ code: "INVALID_TARGET" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not let a remote HTTPS resource downgrade OAuth fetches to loopback HTTP", async () => {
    let loopbackFetches = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const value =
        input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.href
            : input;
      const url = new URL(value);
      if (url.protocol === "http:") {
        loopbackFetches += 1;
        throw new Error("loopback fetch must not happen");
      }
      return new Response(null, {
        status: 401,
        headers: {
          "www-authenticate":
            'Bearer resource_metadata="http://127.0.0.1:9/.well-known/oauth-protected-resource/mcp"',
        },
      });
    });

    await expect(
      beginMcpOAuthAuthorization(
        {
          transport: "http",
          url: "https://resource.example.test/mcp",
          authentication: { type: "oauth" },
        },
        {
          redirectUrl: "http://127.0.0.1:4100/oauth/callback",
          state: "abcdefghijklmnopqrstuvwxyz0123456789_ABCDEF",
        },
      ),
    ).rejects.toMatchObject({ code: "CONNECTION_FAILED" });
    expect(loopbackFetches).toBe(0);
  });

  it("rejects cross-origin OAuth endpoints before requesting them", async () => {
    const requestedUrls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const value =
        input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.href
            : input;
      const url = new URL(value);
      requestedUrls.push(url.href);
      if (url.pathname === "/mcp" && init?.method === "POST") {
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer resource_metadata="https://resource.example.test/.well-known/oauth-protected-resource/mcp"',
          },
        });
      }
      if (
        url.href ===
        "https://resource.example.test/.well-known/oauth-protected-resource/mcp"
      ) {
        return Response.json({
          resource: "https://resource.example.test/mcp",
          authorization_servers: ["https://identity.example.test"],
        });
      }
      throw new Error(`Unexpected fixture request to ${url.href}`);
    });

    await expect(
      beginMcpOAuthAuthorization(
        {
          transport: "http",
          url: "https://resource.example.test/mcp",
          authentication: { type: "oauth" },
        },
        {
          redirectUrl: "http://127.0.0.1:4100/oauth/callback",
          state: "abcdefghijklmnopqrstuvwxyz0123456789_ABCDEF",
        },
      ),
    ).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    expect(requestedUrls).not.toContain(
      "https://identity.example.test/.well-known/oauth-authorization-server",
    );
  });
});
