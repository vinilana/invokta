/**
 * The portable `@invokta/mcp/web` entry point (ADR 0042). It imports no
 * Node.js built-in module, so an engine can serve stateless MCP Streamable
 * HTTP from any runtime with the Fetch API and Web Streams.
 */
import type { CapabilityMap, Engine } from "@invokta/core";

import {
  createMcpHttpProtocol,
  internalFailure,
  type McpHttpHandlerOptions,
  type McpHttpRequestFacts,
} from "./http-protocol.js";

export type {
  McpHttpAuthenticationRequest,
  McpHttpAuthOptions,
  McpHttpHandlerOptions,
  McpHttpHeaderView,
  McpHttpProtectedResourceMetadata,
} from "./http-protocol.js";
export { McpToolNameCollisionError } from "./protocol-server.js";

/** A Web-standard request handler for one engine's MCP endpoint. */
export type McpHttpHandler = (request: Request) => Promise<Response>;

/**
 * Describes a Fetch request for the protocol boundary. The Fetch API merges
 * repeated header fields into one comma-separated value, so a comma marks a
 * repeated `Host` or `Content-Type`, neither of which may legitimately contain
 * one. A merged `Authorization` value is indistinguishable from a single
 * credential with parameters and reaches the authenticator as one value.
 */
function describeRequest(request: Request): McpHttpRequestFacts {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  const host = headers.get("host");
  const authority = `${url.protocol}//${url.host}`;
  const httpUrl = url.protocol === "http:" || url.protocol === "https:";
  return {
    method: request.method,
    target: url.href.startsWith(authority)
      ? url.href.slice(authority.length)
      : "",
    authorities:
      !httpUrl || host?.includes(",") === true
        ? null
        : host === null
          ? [url.host]
          : [host, url.host],
    headers,
    repeated: (name) =>
      name === "content-type" && headers.get(name)?.includes(",") === true,
    body: request.body,
    signal: request.signal,
  };
}

/**
 * Creates a `(request: Request) => Promise<Response>` handler that serves the
 * engine's stateless MCP endpoint with the same boundary as `serveMcpHttp`.
 * Configuration is validated synchronously; the handler never rejects.
 * Without `allowedHosts`, only the loopback host names are accepted.
 */
export function createMcpHttpHandler<Capabilities extends CapabilityMap>(
  engine: Engine<Capabilities>,
  options: McpHttpHandlerOptions,
): McpHttpHandler {
  const handle = createMcpHttpProtocol(engine, options);
  return async function handleMcpHttp(request: Request): Promise<Response> {
    let facts: McpHttpRequestFacts;
    try {
      facts = describeRequest(request);
    } catch {
      return internalFailure().response;
    }
    return (await handle(facts)).response;
  };
}
