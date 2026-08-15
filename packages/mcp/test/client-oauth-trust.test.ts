import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type Server as NodeHttpServer,
  type ServerResponse,
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

const REDIRECT_URL = "http://127.0.0.1:4100/oauth/callback";
const STATE = "abcdefghijklmnopqrstuvwxyz0123456789_ABCDEF";
const ACCESS_TOKEN = "trust-access-canary";

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

async function startOrigin(listener: RequestListener): Promise<string> {
  const server = createServer(listener);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The OAuth trust fixture did not bind.");
  }
  return `http://127.0.0.1:${String(address.port)}`;
}

interface FixtureOrigins {
  readonly resource: string;
  readonly identity: string;
  /** A separate origin the identity's metadata may delegate endpoints to. */
  readonly endpoints: string;
  readonly unadvertised: string;
}

async function startTrustFixture(
  options: {
    readonly authorizationEndpoint?: (origins: FixtureOrigins) => string;
    readonly authorizationServers?: (
      origins: FixtureOrigins,
    ) => readonly string[];
    readonly registrationEndpoint?: (origins: FixtureOrigins) => string;
    readonly resourceMetadataChallenge?: (origins: FixtureOrigins) => string;
    readonly tokenEndpoint?: (origins: FixtureOrigins) => string;
  } = {},
) {
  const origins = {
    resource: "",
    identity: "",
    endpoints: "",
    unadvertised: "",
  };
  const observed = {
    identityPaths: [] as string[],
    endpointsPaths: [] as string[],
    registrationBodies: [] as string[],
    tokenBodies: [] as string[],
    unadvertisedPaths: [] as string[],
  };

  /** The register and token endpoints, servable from more than one origin. */
  const providerEndpoints = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://provider.invalid");
    if (request.method === "POST" && url.pathname === "/register") {
      const body = await requestBody(request);
      observed.registrationBodies.push(body);
      const metadata = JSON.parse(body) as Record<string, unknown>;
      response
        .writeHead(201, { "content-type": "application/json" })
        .end(
          JSON.stringify({ ...metadata, client_id: "invokta-trust-client" }),
        );
      return;
    }
    if (request.method === "POST" && url.pathname === "/token") {
      observed.tokenBodies.push(await requestBody(request));
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          access_token: ACCESS_TOKEN,
          token_type: "Bearer",
          expires_in: 300,
        }),
      );
      return;
    }
    response.writeHead(404).end();
  };

  origins.resource = await startOrigin(async (request, response) => {
    const url = new URL(request.url ?? "/", origins.resource);
    if (
      request.method === "GET" &&
      url.pathname === "/.well-known/oauth-protected-resource/mcp"
    ) {
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          resource: `${origins.resource}/mcp`,
          authorization_servers: options.authorizationServers?.(origins) ?? [
            origins.identity,
          ],
          scopes_supported: ["tools:read"],
        }),
      );
      return;
    }
    if (request.method === "POST" && url.pathname === "/mcp") {
      if (request.headers.authorization !== `Bearer ${ACCESS_TOKEN}`) {
        await requestBody(request);
        const advertised =
          options.resourceMetadataChallenge?.(origins) ??
          `${origins.resource}/.well-known/oauth-protected-resource/mcp`;
        response
          .writeHead(401, {
            "www-authenticate": `Bearer resource_metadata="${advertised}"`,
          })
          .end();
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
              serverInfo: { name: "trust-fixture", version: "1.0.0" },
            },
          }),
        );
        return;
      }
      if (message.method === "notifications/initialized") {
        response.writeHead(202).end();
        return;
      }
      if (message.method === "tools/list") {
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

  origins.identity = await startOrigin(async (request, response) => {
    const url = new URL(request.url ?? "/", origins.identity);
    observed.identityPaths.push(url.pathname);
    if (
      request.method === "GET" &&
      url.pathname === "/.well-known/oauth-authorization-server"
    ) {
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          issuer: origins.identity,
          authorization_endpoint:
            options.authorizationEndpoint?.(origins) ??
            `${origins.identity}/authorize`,
          token_endpoint:
            options.tokenEndpoint?.(origins) ?? `${origins.identity}/token`,
          registration_endpoint:
            options.registrationEndpoint?.(origins) ??
            `${origins.identity}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
        }),
      );
      return;
    }
    await providerEndpoints(request, response);
  });

  origins.endpoints = await startOrigin(async (request, response) => {
    observed.endpointsPaths.push(
      new URL(request.url ?? "/", origins.endpoints).pathname,
    );
    await providerEndpoints(request, response);
  });

  origins.unadvertised = await startOrigin((request, response) => {
    observed.unadvertisedPaths.push(
      new URL(request.url ?? "/", origins.unadvertised).pathname,
    );
    response.writeHead(404).end();
  });

  return { origins, observed, url: `${origins.resource}/mcp` };
}

function oauthTarget(url: string) {
  return { transport: "http", url, authentication: { type: "oauth" } } as const;
}

describe("advertised OAuth authorization servers", () => {
  it("authorizes through an authorization server on another advertised origin", async () => {
    const fixture = await startTrustFixture();

    const authorization = await beginMcpOAuthAuthorization(
      oauthTarget(fixture.url),
      { redirectUrl: REDIRECT_URL, state: STATE },
    );
    authorizations.push(authorization);

    const authorizationUrl = new URL(authorization.authorizationUrl);
    expect(authorizationUrl.origin).toBe(fixture.origins.identity);
    expect(authorizationUrl.pathname).toBe("/authorize");
    expect(authorizationUrl.searchParams.get("state")).toBe(STATE);
    expect(authorizationUrl.searchParams.get("code_challenge")).not.toBeNull();
    expect(authorizationUrl.searchParams.get("resource")).toBe(fixture.url);
    expect(fixture.observed.registrationBodies).toHaveLength(1);

    const connection = await authorization.finish("one-time-code");
    connections.push(connection);
    expect(connection.server).toMatchObject({ name: "trust-fixture" });
    await expect(connection.listTools()).resolves.toEqual({ tools: [] });
    expect(
      new URLSearchParams(fixture.observed.tokenBodies[0] ?? "").get(
        "resource",
      ),
    ).toBe(fixture.url);
  });

  it("follows the OAuth endpoints the validated metadata places on another origin", async () => {
    // The hosted-provider shape: the issuer answers discovery, but its
    // endpoints live on an origin the resource document never names — the way
    // Cognito serves its OAuth endpoints apart from the issuer.
    const fixture = await startTrustFixture({
      authorizationEndpoint: (origins) => `${origins.endpoints}/authorize`,
      registrationEndpoint: (origins) => `${origins.endpoints}/register`,
      tokenEndpoint: (origins) => `${origins.endpoints}/token`,
    });

    const authorization = await beginMcpOAuthAuthorization(
      oauthTarget(fixture.url),
      { redirectUrl: REDIRECT_URL, state: STATE },
    );
    authorizations.push(authorization);

    const authorizationUrl = new URL(authorization.authorizationUrl);
    expect(authorizationUrl.origin).toBe(fixture.origins.endpoints);
    expect(authorizationUrl.searchParams.get("state")).toBe(STATE);
    expect(fixture.observed.endpointsPaths).toContain("/register");

    const connection = await authorization.finish("one-time-code");
    connections.push(connection);
    expect(fixture.observed.endpointsPaths).toContain("/token");
    expect(
      new URLSearchParams(fixture.observed.tokenBodies[0] ?? "").get(
        "resource",
      ),
    ).toBe(fixture.url);
  });

  it("refuses a metadata endpoint that is neither HTTPS nor loopback", async () => {
    const fixture = await startTrustFixture({
      authorizationEndpoint: () => "http://identity.example.test/authorize",
    });

    await expect(
      beginMcpOAuthAuthorization(oauthTarget(fixture.url), {
        redirectUrl: REDIRECT_URL,
        state: STATE,
      }),
    ).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  });

  it("refuses a metadata endpoint that carries a fragment", async () => {
    const fixture = await startTrustFixture({
      tokenEndpoint: (origins) => `${origins.unadvertised}/token#fragment`,
    });

    await expect(
      beginMcpOAuthAuthorization(oauthTarget(fixture.url), {
        redirectUrl: REDIRECT_URL,
        state: STATE,
      }),
    ).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    expect(fixture.observed.unadvertisedPaths).toEqual([]);
  });

  it("refuses an advertised authorization server carrying a query", async () => {
    const fixture = await startTrustFixture({
      authorizationServers: (origins) => [`${origins.identity}?tenant=x`],
    });

    await expect(
      beginMcpOAuthAuthorization(oauthTarget(fixture.url), {
        redirectUrl: REDIRECT_URL,
        state: STATE,
      }),
    ).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    expect(fixture.observed.identityPaths).toEqual([]);
  });

  it("refuses an advertised authorization server served over plain HTTP", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const fixture = await startTrustFixture({
      authorizationServers: () => ["http://identity.example.test"],
    });

    await expect(
      beginMcpOAuthAuthorization(oauthTarget(fixture.url), {
        redirectUrl: REDIRECT_URL,
        state: STATE,
      }),
    ).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    expect(
      fetchSpy.mock.calls.map(([input]) => String(input)),
    ).not.toContainEqual(
      expect.stringContaining("http://identity.example.test"),
    );
  });

  it("does not let a remote HTTPS resource advertise a loopback authorization server", async () => {
    let loopbackFetches = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(
        input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.href
            : input,
      );
      if (url.protocol === "http:") {
        loopbackFetches += 1;
        throw new Error("loopback fetch must not happen");
      }
      if (url.pathname === "/mcp" && init?.method === "POST") {
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer resource_metadata="https://resource.example.test/.well-known/oauth-protected-resource/mcp"',
          },
        });
      }
      return Response.json({
        resource: "https://resource.example.test/mcp",
        authorization_servers: ["http://127.0.0.1:9"],
      });
    });

    await expect(
      beginMcpOAuthAuthorization(
        oauthTarget("https://resource.example.test/mcp"),
        { redirectUrl: REDIRECT_URL, state: STATE },
      ),
    ).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    expect(loopbackFetches).toBe(0);
  });

  it("reads protected resource metadata only from the resource origin", async () => {
    const fixture = await startTrustFixture({
      resourceMetadataChallenge: (origins) =>
        `${origins.identity}/.well-known/oauth-protected-resource/mcp`,
    });

    await expect(
      beginMcpOAuthAuthorization(oauthTarget(fixture.url), {
        redirectUrl: REDIRECT_URL,
        state: STATE,
      }),
    ).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    expect(fixture.observed.identityPaths).toEqual([]);
  });
});
