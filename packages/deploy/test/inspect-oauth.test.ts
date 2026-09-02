import {
  createServer,
  type IncomingMessage,
  type Server as NodeHttpServer,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { runInspectOAuth } from "../src/inspect-oauth.js";
import { createTestContext } from "./support/test-context.js";

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly cookie: string | undefined;
  readonly protocolVersion: string | undefined;
}

interface OAuthStub {
  readonly endpoint: string;
  readonly origin: string;
  readonly requests: readonly RecordedRequest[];
  close(): Promise<void>;
}

interface OAuthStubOptions {
  readonly challenge?: (origin: string) => string;
  readonly resource?: (origin: string) => unknown;
  readonly metadata?: (origin: string) => unknown;
  readonly metadataPath?: string;
  readonly onPath?: (
    path: string,
    request: IncomingMessage,
    response: ServerResponse,
  ) => boolean;
}

const openServers: NodeHttpServer[] = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function startOAuthStub(
  options: OAuthStubOptions = {},
): Promise<OAuthStub> {
  let origin = "";
  const requests: RecordedRequest[] = [];
  const metadataPath =
    options.metadataPath ?? "/.well-known/oauth-authorization-server";
  const server = createServer((request, response) => {
    const path = request.url ?? "/";
    requests.push({
      method: request.method ?? "",
      path,
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
      protocolVersion: request.headers["mcp-protocol-version"] as
        | string
        | undefined,
    });
    request.resume();
    request.once("end", () => {
      if (options.onPath?.(path, request, response) === true) return;
      if (path === "/mcp") {
        response.writeHead(401, {
          "www-authenticate":
            options.challenge?.(origin) ??
            `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="mcp:tools"`,
        });
        response.end();
        return;
      }
      if (path === "/.well-known/oauth-protected-resource/mcp") {
        json(
          response,
          options.resource?.(origin) ?? {
            resource: `${origin}/mcp`,
            authorization_servers: [origin],
            scopes_supported: ["mcp:tools"],
          },
        );
        return;
      }
      if (path === metadataPath) {
        json(
          response,
          options.metadata?.(origin) ?? {
            issuer: origin,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            registration_endpoint: `${origin}/register`,
            jwks_uri: `${origin}/jwks`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code"],
            code_challenge_methods_supported: ["S256"],
          },
        );
        return;
      }
      if (path === "/jwks") {
        json(response, {
          keys: [{ kty: "EC", crv: "P-256", x: "x", y: "y", kid: "1" }],
        });
        return;
      }
      response.writeHead(404).end();
    });
  });
  openServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${String(port)}`;
  return {
    endpoint: `${origin}/mcp`,
    origin,
    requests,
    async close() {
      const index = openServers.indexOf(server);
      if (index !== -1) openServers.splice(index, 1);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function inspect(args: readonly string[]) {
  const harness = createTestContext();
  const exitCode = await runInspectOAuth(args, harness.context);
  return { exitCode, stdout: harness.stdout, stderr: harness.stderr };
}

function failure(endpoint: string, stage: string, reason: string): string {
  return `OAUTH_INSPECTION_FAILED: OAuth discovery is not ready.
  url: ${endpoint}
  stage: ${stage}
  reason: ${reason}
`;
}

describe("runInspectOAuth", () => {
  it("inspects challenge, protected resource, authorization server, and JWKS without credentials", async () => {
    const stub = await startOAuthStub();

    const result = await inspect(["--url", stub.endpoint]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toEqual([
      `OAUTH_INSPECTION_OK: OAuth discovery is ready.
  resource: ${stub.endpoint}
  issuer: ${stub.origin}
  challenge-scopes: mcp:tools
  registration: dcr
  jwks: valid
`,
    ]);
    expect(
      stub.requests.map(({ method, path }) => `${method} ${path}`),
    ).toEqual([
      "POST /mcp",
      "GET /.well-known/oauth-protected-resource/mcp",
      "GET /.well-known/oauth-authorization-server",
      "GET /jwks",
    ]);
    for (const request of stub.requests) {
      expect(request.authorization).toBeUndefined();
      expect(request.cookie).toBeUndefined();
      expect(request.protocolVersion).toBe("2025-11-25");
    }
  });

  it("uses the MCP discovery order for an issuer with a path and reports CIMD before DCR", async () => {
    let origin = "";
    const stub = await startOAuthStub({
      metadataPath: "/tenant/.well-known/openid-configuration",
      resource: (value) => {
        origin = value;
        return {
          resource: `${value}/mcp`,
          authorization_servers: [`${value}/tenant`],
        };
      },
      metadata: () => ({
        issuer: `${origin}/tenant`,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        client_id_metadata_document_supported: true,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"],
      }),
    });

    const result = await inspect(["--url", stub.endpoint]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr.join("")).toContain("registration: cimd,dcr");
    expect(stub.requests.map(({ path }) => path)).toEqual([
      "/mcp",
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-authorization-server/tenant",
      "/.well-known/openid-configuration/tenant",
      "/tenant/.well-known/openid-configuration",
    ]);
  });

  it("inspects an engine mounted under a path prefix", async () => {
    const mountPath = "/e/orders/mcp";
    const stub = await startOAuthStub({
      onPath(path, _request, response) {
        if (path === mountPath) {
          response.writeHead(401, {
            "www-authenticate": `Bearer resource_metadata="${stub.origin}/.well-known/oauth-protected-resource${mountPath}", scope="mcp:tools"`,
          });
          response.end();
          return true;
        }
        if (path === `/.well-known/oauth-protected-resource${mountPath}`) {
          json(response, {
            resource: `${stub.origin}${mountPath}`,
            authorization_servers: [stub.origin],
            scopes_supported: ["mcp:tools"],
          });
          return true;
        }
        return false;
      },
    });

    const result = await inspect(["--url", `${stub.origin}${mountPath}`]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toEqual([]);
    expect(result.stderr.join("")).toContain(
      `OAUTH_INSPECTION_OK: OAuth discovery is ready.\n  resource: ${stub.origin}${mountPath}\n`,
    );
    expect(stub.requests.map((request) => request.path)).toEqual([
      mountPath,
      `/.well-known/oauth-protected-resource${mountPath}`,
      "/.well-known/oauth-authorization-server",
      "/jwks",
    ]);
  });

  it("accepts a loopback authorization server on another loopback port", async () => {
    // A local identity provider normally runs as its own process on its own
    // port; `serveMcpHttp` publishes this topology and `inspectMcpOAuth`
    // accepts it, so this inspector must agree.
    const identity = await startOAuthStub();
    const stub = await startOAuthStub({
      resource: (origin) => ({
        resource: `${origin}/mcp`,
        authorization_servers: [identity.origin],
        scopes_supported: ["mcp:tools"],
      }),
    });

    const result = await inspect(["--url", stub.endpoint]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr.join("")).toContain(`issuer: ${identity.origin}`);
    expect(identity.requests.map(({ path }) => path)).toEqual([
      "/.well-known/oauth-authorization-server",
      "/jwks",
    ]);
  });

  it("fails at the challenge stage when resource metadata is not advertised", async () => {
    const stub = await startOAuthStub({ challenge: () => "Bearer" });

    const result = await inspect(["--url", stub.endpoint]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toEqual([
      failure(stub.endpoint, "CHALLENGE", "RESOURCE_METADATA_NOT_ADVERTISED"),
    ]);
    expect(stub.requests).toHaveLength(1);
  });

  it("fails closed when protected resource metadata names another resource", async () => {
    const stub = await startOAuthStub({
      resource: () => ({
        resource: "https://other.example/mcp",
        authorization_servers: ["https://auth.example"],
      }),
    });

    const result = await inspect(["--url", stub.endpoint]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toEqual([
      failure(stub.endpoint, "RESOURCE_METADATA", "RESOURCE_MISMATCH"),
    ]);
  });

  it("does not follow discovery redirects", async () => {
    const stub = await startOAuthStub({
      onPath(path, _request, response) {
        if (path !== "/.well-known/oauth-protected-resource/mcp") return false;
        response.writeHead(302, { location: "http://127.0.0.1/private" }).end();
        return true;
      },
    });

    const result = await inspect(["--url", stub.endpoint]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toEqual([
      failure(stub.endpoint, "RESOURCE_METADATA", "REDIRECT_NOT_ALLOWED"),
    ]);
    expect(stub.requests).toHaveLength(2);
  });

  it("rejects a challenge that downgrades discovery to another HTTP origin", async () => {
    const stub = await startOAuthStub({
      challenge: () =>
        'Bearer resource_metadata="http://127.0.0.1:1/.well-known/oauth-protected-resource/mcp"',
    });

    const result = await inspect(["--url", stub.endpoint]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toEqual([
      failure(stub.endpoint, "CHALLENGE", "UNSAFE_URL"),
    ]);
    expect(stub.requests).toHaveLength(1);
  });

  it("reports unavailable authorization server metadata after bounded fallbacks", async () => {
    const stub = await startOAuthStub({ metadataPath: "/not-published" });

    const result = await inspect(["--url", stub.endpoint]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toEqual([
      failure(
        stub.endpoint,
        "AUTHORIZATION_SERVER_METADATA",
        "METADATA_NOT_FOUND",
      ),
    ]);
    expect(stub.requests.map(({ path }) => path)).toEqual([
      "/mcp",
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-authorization-server",
      "/.well-known/openid-configuration",
    ]);
  });

  it("requires the advertised OAuth capabilities needed by MCP", async () => {
    const stub = await startOAuthStub({
      metadata: (origin) => ({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["plain"],
      }),
    });

    const result = await inspect(["--url", stub.endpoint]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toEqual([
      failure(
        stub.endpoint,
        "AUTHORIZATION_SERVER_CAPABILITIES",
        "S256_NOT_ADVERTISED",
      ),
    ]);
  });

  it("classifies malformed discovery JSON without echoing it", async () => {
    const secret = "malformed-secret";
    const stub = await startOAuthStub({
      onPath(path, _request, response) {
        if (path !== "/.well-known/oauth-protected-resource/mcp") return false;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(`{"${secret}":`);
        return true;
      },
    });

    const result = await inspect(["--url", stub.endpoint]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toEqual([
      failure(stub.endpoint, "RESOURCE_METADATA", "INVALID_JSON"),
    ]);
    expect(result.stderr.join("")).not.toContain(secret);
  });

  it("rejects an advertised JWKS without public key objects", async () => {
    const stub = await startOAuthStub({
      onPath(path, _request, response) {
        if (path !== "/jwks") return false;
        json(response, { keys: [] });
        return true;
      },
    });

    const result = await inspect(["--url", stub.endpoint]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toEqual([
      failure(stub.endpoint, "JWKS", "INVALID_JWKS"),
    ]);
  });

  it("bounds the entire inspection with one deadline", async () => {
    const stub = await startOAuthStub({
      onPath(path) {
        return path === "/.well-known/oauth-protected-resource/mcp";
      },
    });

    const result = await inspect([
      "--url",
      stub.endpoint,
      "--timeout-ms",
      "80",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toEqual([
      failure(stub.endpoint, "RESOURCE_METADATA", "DEADLINE_EXCEEDED"),
    ]);
  });

  it("rejects oversized metadata without printing its body", async () => {
    const secret = "response-secret-that-must-not-be-printed";
    const stub = await startOAuthStub({
      onPath(path, _request, response) {
        if (path !== "/.well-known/oauth-protected-resource/mcp") return false;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ padding: `${secret}${"x".repeat(300_000)}` }),
        );
        return true;
      },
    });

    const result = await inspect(["--url", stub.endpoint]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toEqual([
      failure(stub.endpoint, "RESOURCE_METADATA", "RESPONSE_TOO_LARGE"),
    ]);
    expect(result.stderr.join("")).not.toContain(secret);
  });

  it("validates advertised JWKS structurally without assuming JWT tokens", async () => {
    const withoutJwks = await startOAuthStub({
      metadata: (origin) => ({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"],
      }),
    });

    const result = await inspect(["--url", withoutJwks.endpoint]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr.join("")).toContain(
      "registration: pre-registration-required",
    );
    expect(result.stderr.join("")).toContain("jwks: not-advertised");
    expect(withoutJwks.requests.map(({ path }) => path)).not.toContain("/jwks");
  });
});
