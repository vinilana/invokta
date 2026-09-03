import { request as httpRequest } from "node:http";

import { createEngine, defineCapability } from "@invokta/core";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  type McpHttpAuthenticationRequest,
  type McpHttpServerHandle,
  serveMcpHttp,
} from "../src/index.js";

const openServers: McpHttpServerHandle[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

const engine = createEngine({
  name: "mount-path-engine",
  version: "0.1.0",
  capabilities: {
    "orders.list": defineCapability({
      description: "Lists orders.",
      input: z.object({}),
      output: z.object({ count: z.number() }),
      access: "authenticated",
      async run() {
        return { count: 1 };
      },
    }),
  },
});

function url(server: McpHttpServerHandle, path: string): string {
  const address = server.address();
  return `http://${address.host}:${address.port}${path}`;
}

/**
 * Sends the request target byte for byte. `fetch` removes dot segments before
 * the request leaves the process, so an alias must be sent over `node:http`.
 */
function rawStatus(server: McpHttpServerHandle, path: string): Promise<number> {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: address.host,
        port: address.port,
        method: "POST",
        path,
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          authorization: "Bearer alice",
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.on("error", reject);
    request.end("{}");
  });
}

function callTool(server: McpHttpServerHandle, path: string) {
  return fetch(url(server, path), {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      authorization: "Bearer alice",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "1",
      method: "tools/call",
      params: { name: "orders_list", arguments: {} },
    }),
  });
}

describe("serveMcpHttp mount path", () => {
  it("serves the protocol only at the configured path", async () => {
    const seen: string[] = [];
    const server = await serveMcpHttp(engine, {
      port: 0,
      path: "/e/orders/mcp",
      auth: {
        mode: "required",
        authenticate(request: McpHttpAuthenticationRequest) {
          seen.push(request.path);
          return { id: "user:alice" };
        },
      },
    });
    openServers.push(server);

    const mounted = await callTool(server, "/e/orders/mcp");
    const canonicalDefault = await callTool(server, "/mcp");
    const alias = await rawStatus(server, "/e/orders/../orders/mcp");
    const encoded = await rawStatus(server, "/e/%6frders/mcp");

    expect(mounted.status).toBe(200);
    expect(await mounted.text()).toContain('"count":1');
    expect(canonicalDefault.status).toBe(404);
    expect(alias).toBe(400);
    expect(encoded).toBe(400);
    expect(seen).toEqual(["/e/orders/mcp"]);
  });

  it("publishes protected resource metadata under the mounted path", async () => {
    const resource = "https://gateway.example.com/e/orders/mcp";
    const server = await serveMcpHttp(engine, {
      port: 0,
      path: "/e/orders/mcp",
      auth: {
        mode: "required",
        authenticate: () => null,
        challengeScopes: ["mcp:tools"],
        resourceMetadata: {
          resource,
          authorizationServers: ["https://gateway.example.com"],
        },
      },
    });
    openServers.push(server);

    const unauthorized = await callTool(server, "/e/orders/mcp");
    const metadata = await fetch(
      url(server, "/.well-known/oauth-protected-resource/e/orders/mcp"),
    );
    const defaultMetadata = await fetch(
      url(server, "/.well-known/oauth-protected-resource/mcp"),
    );

    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://gateway.example.com/.well-known/oauth-protected-resource/e/orders/mcp", scope="mcp:tools"',
    );
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toEqual({
      resource,
      authorization_servers: ["https://gateway.example.com"],
    });
    expect(defaultMetadata.status).toBe(404);
  });

  it("requires the resource path to equal the mounted path", async () => {
    await expect(
      serveMcpHttp(engine, {
        port: 0,
        path: "/e/orders/mcp",
        auth: {
          mode: "required",
          authenticate: () => null,
          resourceMetadata: {
            resource: "https://gateway.example.com/mcp",
            authorizationServers: ["https://gateway.example.com"],
          },
        },
      }),
    ).rejects.toThrow("/e/orders/mcp");

    await expect(
      serveMcpHttp(engine, {
        port: 0,
        auth: {
          mode: "required",
          authenticate: () => null,
          resourceMetadata: {
            resource: "https://gateway.example.com/e/orders/mcp",
            authorizationServers: ["https://gateway.example.com"],
          },
        },
      }),
    ).rejects.toThrow("/mcp");
  });

  it.each([
    ["a path without the /mcp suffix", "/e/orders"],
    ["a trailing slash", "/e/orders/mcp/"],
    ["a relative path", "e/orders/mcp"],
    ["an empty segment", "/e//mcp"],
    ["a dot segment", "/e/./mcp"],
    ["a parent segment", "/e/../mcp"],
    ["percent encoding", "/e/%6frders/mcp"],
    ["a query", "/e/orders/mcp?x=1"],
    ["a fragment", "/e/orders/mcp#x"],
    ["a reserved character", "/e/or:ders/mcp"],
    ["whitespace", "/e/or ders/mcp"],
    ["an empty string", ""],
    ["a path longer than 256 bytes", `/${"e".repeat(253)}/mcp`],
  ])("rejects %s before listening", async (_label, path) => {
    await expect(
      serveMcpHttp(engine, {
        port: 0,
        path,
        auth: { mode: "required", authenticate: () => null },
      }),
    ).rejects.toThrow("path");
  });

  it("accepts the longest canonical path and the default path", async () => {
    const longest = `/${"e".repeat(251)}/mcp`;
    expect(Buffer.byteLength(longest)).toBe(256);
    const server = await serveMcpHttp(engine, {
      port: 0,
      path: longest,
      auth: { mode: "required", authenticate: () => ({ id: "user:alice" }) },
    });
    openServers.push(server);
    const explicitDefault = await serveMcpHttp(engine, {
      port: 0,
      path: "/mcp",
      auth: { mode: "required", authenticate: () => ({ id: "user:alice" }) },
    });
    openServers.push(explicitDefault);

    expect((await callTool(server, longest)).status).toBe(200);
    expect((await callTool(explicitDefault, "/mcp")).status).toBe(200);
  });
});
