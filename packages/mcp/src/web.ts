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
export {
  type McpCapabilityVisibility,
  McpToolNameCollisionError,
} from "./protocol-server.js";

/** A Web-standard request handler for one engine's MCP endpoint. */
export type McpHttpHandler = (request: Request) => Promise<Response>;

/**
 * Whether a field value contains a comma outside an RFC 9110 quoted string,
 * which is where the Fetch API separates the values of repeated fields. An
 * unterminated quoted string could hide that comma, so it counts as one too.
 */
function hasUnquotedComma(value: string): boolean {
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quoted && character === "\\") index += 1;
    else if (character === '"') quoted = !quoted;
    else if (character === "," && !quoted) return true;
  }
  return quoted;
}

/**
 * Describes a Fetch request for the protocol boundary. The Fetch API merges
 * repeated header fields into one comma-separated value. A `Host` cannot
 * contain a comma, and a single `Content-Type` can contain one only inside a
 * quoted parameter value, so any other comma marks a repeated field. A merged
 * `Authorization` value is indistinguishable from a single credential with
 * parameters and reaches the authenticator as one value.
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
    repeated: (name) => {
      const value = name === "content-type" ? headers.get(name) : null;
      return value !== null && hasUnquotedComma(value);
    },
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
