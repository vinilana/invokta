import {
  createServer,
  type RequestListener,
  type Server as NodeHttpServer,
} from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { inspectMcpOAuth, type McpOAuthStep } from "../src/index.js";

const servers: NodeHttpServer[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

async function startOrigin(listener: RequestListener): Promise<string> {
  const server = createServer(listener);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The OAuth inspection fixture did not bind.");
  }
  return `http://127.0.0.1:${String(address.port)}`;
}

interface FixtureOrigins {
  readonly resource: string;
  readonly identity: string;
}

async function startInspectionFixture(
  options: {
    readonly authorizationServerMetadata?: (
      origins: FixtureOrigins,
    ) => McpOAuthStep["detail"];
    readonly authorizationServerStatus?: number;
    readonly authorizationServers?: (
      origins: FixtureOrigins,
    ) => readonly string[];
    readonly challengeStatus?: number;
    readonly resourceMetadataBody?: (origins: FixtureOrigins) => string;
    readonly resourceMetadataStatus?: number;
    readonly stopIdentity?: boolean;
  } = {},
) {
  const origins = { resource: "", identity: "" };
  const observed = {
    resourcePaths: [] as string[],
    identityPaths: [] as string[],
  };

  origins.identity = await startOrigin((request, response) => {
    const url = new URL(request.url ?? "/", origins.identity);
    observed.identityPaths.push(url.pathname);
    if (url.pathname !== "/.well-known/oauth-authorization-server") {
      response.writeHead(404).end();
      return;
    }
    if (options.authorizationServerStatus !== undefined) {
      response.writeHead(options.authorizationServerStatus).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify(
        options.authorizationServerMetadata?.(origins) ?? {
          issuer: origins.identity,
          authorization_endpoint: `${origins.identity}/authorize`,
          token_endpoint: `${origins.identity}/token`,
          registration_endpoint: `${origins.identity}/register`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
        },
      ),
    );
  });

  origins.resource = await startOrigin((request, response) => {
    const url = new URL(request.url ?? "/", origins.resource);
    observed.resourcePaths.push(url.pathname);
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      if (options.resourceMetadataStatus !== undefined) {
        response.writeHead(options.resourceMetadataStatus).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" }).end(
        options.resourceMetadataBody?.(origins) ??
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
      if (options.challengeStatus !== undefined) {
        response.writeHead(options.challengeStatus).end();
        return;
      }
      response
        .writeHead(401, {
          "www-authenticate": `Bearer resource_metadata="${origins.resource}/.well-known/oauth-protected-resource/mcp"`,
        })
        .end();
      return;
    }
    response.writeHead(404).end();
  });

  const identity = servers[0];
  if (options.stopIdentity === true && identity !== undefined) {
    servers.shift();
    await new Promise<void>((resolve) => identity.close(() => resolve()));
  }

  return { origins, observed, url: `${origins.resource}/mcp` };
}

function oauthTarget(url: string) {
  return { transport: "http", url, authentication: { type: "oauth" } } as const;
}

function outcomes(steps: readonly McpOAuthStep[]) {
  return steps.map((step) => [step.name, step.outcome]);
}

describe("read-only MCP OAuth discovery inspection", () => {
  it("reports every discovery step as ok against a conforming resource", async () => {
    const fixture = await startInspectionFixture();

    const inspection = await inspectMcpOAuth(oauthTarget(fixture.url));

    expect(outcomes(inspection.steps)).toEqual([
      ["challenge", "ok"],
      ["resource-metadata", "ok"],
      ["authorization-server-metadata", "ok"],
      ["registration", "ok"],
    ]);
    expect(inspection.ready).toBe(true);
    expect(inspection.steps.map((step) => step.hint)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(inspection.steps[1]?.detail).toMatchObject({
      resource: fixture.url,
      authorization_servers: [fixture.origins.identity],
    });
    expect(inspection.steps[2]?.detail).toMatchObject({
      issuer: fixture.origins.identity,
    });
  });

  it("never authorizes, registers, or sends a credential", async () => {
    const fixture = await startInspectionFixture();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await inspectMcpOAuth(oauthTarget(fixture.url));

    for (const [, init] of fetchSpy.mock.calls) {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
    }
    expect(fixture.observed.resourcePaths).toEqual([
      "/mcp",
      "/.well-known/oauth-protected-resource/mcp",
    ]);
    expect(fixture.observed.identityPaths).toEqual([
      "/.well-known/oauth-authorization-server",
    ]);
  });

  it("reports a missing protected resource metadata document and skips what depends on it", async () => {
    const fixture = await startInspectionFixture({
      resourceMetadataStatus: 404,
    });

    const inspection = await inspectMcpOAuth(oauthTarget(fixture.url));

    expect(outcomes(inspection.steps)).toEqual([
      ["challenge", "ok"],
      ["resource-metadata", "failed"],
      ["authorization-server-metadata", "skipped"],
      ["registration", "skipped"],
    ]);
    expect(inspection.ready).toBe(false);
    expect(inspection.steps[1]?.summary).toContain("404");
    expect(inspection.steps[1]?.hint).toContain(
      "/.well-known/oauth-protected-resource/mcp",
    );
    expect(inspection.steps[2]?.summary).toContain(
      "protected resource metadata",
    );
    expect(fixture.observed.identityPaths).toEqual([]);
  });

  it("reports an unreachable authorization server and skips registration", async () => {
    const fixture = await startInspectionFixture({ stopIdentity: true });

    const inspection = await inspectMcpOAuth(oauthTarget(fixture.url));

    expect(outcomes(inspection.steps)).toEqual([
      ["challenge", "ok"],
      ["resource-metadata", "ok"],
      ["authorization-server-metadata", "failed"],
      ["registration", "skipped"],
    ]);
    expect(inspection.ready).toBe(false);
    expect(inspection.steps[2]?.summary).toContain("could not be read");
    expect(inspection.steps[3]?.outcome).toBe("skipped");
  });

  it("reports a malformed protected resource metadata document", async () => {
    const fixture = await startInspectionFixture({
      resourceMetadataBody: () => "{",
    });

    const inspection = await inspectMcpOAuth(oauthTarget(fixture.url));

    expect(outcomes(inspection.steps)).toEqual([
      ["challenge", "ok"],
      ["resource-metadata", "failed"],
      ["authorization-server-metadata", "skipped"],
      ["registration", "skipped"],
    ]);
    expect(inspection.ready).toBe(false);
    expect(inspection.steps[1]?.summary).toContain("not a JSON document");
    expect(inspection.steps[1]?.detail).toBeUndefined();
  });

  it("reports a resource identifier that does not match the target", async () => {
    const fixture = await startInspectionFixture({
      resourceMetadataBody: (origins) =>
        JSON.stringify({
          resource: `${origins.resource}/mcp/`,
          authorization_servers: [origins.identity],
        }),
    });

    const inspection = await inspectMcpOAuth(oauthTarget(fixture.url));

    expect(inspection.steps[1]).toMatchObject({
      name: "resource-metadata",
      outcome: "failed",
    });
    expect(inspection.steps[1]?.hint).toContain(fixture.url);
    expect(inspection.steps[1]?.detail).toMatchObject({
      resource: `${fixture.url}/`,
    });
    expect(inspection.ready).toBe(false);
  });

  it("reports an authorization server issuer that does not exactly match", async () => {
    const fixture = await startInspectionFixture({
      authorizationServerMetadata: (origins) => ({
        issuer: `${origins.identity}/`,
        authorization_endpoint: `${origins.identity}/authorize`,
        token_endpoint: `${origins.identity}/token`,
        registration_endpoint: `${origins.identity}/register`,
        response_types_supported: ["code"],
      }),
    });

    const inspection = await inspectMcpOAuth(oauthTarget(fixture.url));

    expect(outcomes(inspection.steps)).toEqual([
      ["challenge", "ok"],
      ["resource-metadata", "ok"],
      ["authorization-server-metadata", "failed"],
      ["registration", "skipped"],
    ]);
    expect(inspection.steps[2]?.hint).toContain("trailing slash");
    expect(inspection.ready).toBe(false);
  });

  it("reports an authorization server without dynamic client registration", async () => {
    const fixture = await startInspectionFixture({
      authorizationServerMetadata: (origins) => ({
        issuer: origins.identity,
        authorization_endpoint: `${origins.identity}/authorize`,
        token_endpoint: `${origins.identity}/token`,
        response_types_supported: ["code"],
      }),
    });

    const inspection = await inspectMcpOAuth(oauthTarget(fixture.url));

    expect(outcomes(inspection.steps)).toEqual([
      ["challenge", "ok"],
      ["resource-metadata", "ok"],
      ["authorization-server-metadata", "ok"],
      ["registration", "failed"],
    ]);
    expect(inspection.steps[3]?.hint).toContain("dynamic client registration");
    expect(inspection.ready).toBe(false);
  });

  it("reports an endpoint that answers without an OAuth challenge", async () => {
    const fixture = await startInspectionFixture({ challengeStatus: 200 });

    const inspection = await inspectMcpOAuth(oauthTarget(fixture.url));

    expect(inspection.steps[0]).toMatchObject({
      name: "challenge",
      outcome: "failed",
    });
    expect(inspection.steps[0]?.summary).toContain("200");
    expect(inspection.steps[1]?.outcome).toBe("ok");
    expect(inspection.ready).toBe(false);
  });

  it("reports an authorization server the resource may not advertise", async () => {
    const fixture = await startInspectionFixture({
      authorizationServers: () => ["http://identity.example.test"],
    });

    const inspection = await inspectMcpOAuth(oauthTarget(fixture.url));

    expect(outcomes(inspection.steps)).toEqual([
      ["challenge", "ok"],
      ["resource-metadata", "failed"],
      ["authorization-server-metadata", "skipped"],
      ["registration", "skipped"],
    ]);
    expect(inspection.steps[1]?.summary).toContain(
      "http://identity.example.test",
    );
    expect(inspection.ready).toBe(false);
  });

  it("reports an unreachable MCP endpoint without throwing", async () => {
    const inspection = await inspectMcpOAuth(
      oauthTarget("http://127.0.0.1:1/mcp"),
    );

    expect(outcomes(inspection.steps)).toEqual([
      ["challenge", "failed"],
      ["resource-metadata", "failed"],
      ["authorization-server-metadata", "skipped"],
      ["registration", "skipped"],
    ]);
    expect(inspection.ready).toBe(false);
  });

  it("throws only for an invalid target", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(
      inspectMcpOAuth({
        transport: "http",
        url: "ftp://example.test/mcp",
        authentication: { type: "oauth" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_TARGET" });
    await expect(
      inspectMcpOAuth(
        oauthTarget("https://example.test/mcp"),
        // @ts-expect-error The operation options accept only an abort signal.
        { deadline: 1 },
      ),
    ).rejects.toMatchObject({ code: "INVALID_TARGET" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("cancels an inspection through the supplied abort signal", async () => {
    const fixture = await startInspectionFixture();
    const aborted = new AbortController();
    aborted.abort();

    await expect(
      inspectMcpOAuth(oauthTarget(fixture.url), { signal: aborted.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED" });

    const inFlight = new AbortController();
    const stalled = await startOrigin(() => inFlight.abort());
    await expect(
      inspectMcpOAuth(oauthTarget(`${stalled}/mcp`), {
        signal: inFlight.signal,
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
  });
});
