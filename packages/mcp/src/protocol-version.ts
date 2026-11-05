import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type {
  AnyObjectSchema,
  SchemaOutput,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
  InitializeRequestSchema,
  type Notification,
  type Request,
  type Result,
  type ServerNotification,
  type ServerRequest,
  type ServerResult,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js";

type ServerRequestExtra = RequestHandlerExtra<
  ServerRequest | Request,
  ServerNotification | Notification
>;

function supportedProtocolVersion(value: unknown): string | undefined {
  return typeof value === "string" &&
    SUPPORTED_PROTOCOL_VERSIONS.includes(value)
    ? value
    : undefined;
}

/**
 * A protocol server that knows which MCP revision governs each request, so a
 * tool result only uses content block types that revision defines (ADR 0044).
 *
 * The SDK negotiates the revision in its `initialize` handler, which its
 * constructor registers through `setRequestHandler`, but it does not expose
 * the result. This override wraps that handler without replacing the SDK's
 * negotiation and records the revision it returned.
 */
export class ProtocolVersionServer extends Server {
  #negotiatedProtocolVersion: string | undefined;

  override setRequestHandler<T extends AnyObjectSchema>(
    requestSchema: T,
    handler: (
      request: SchemaOutput<T>,
      extra: ServerRequestExtra,
    ) => ServerResult | Result | Promise<ServerResult | Result>,
  ): void {
    if ((requestSchema as unknown) !== InitializeRequestSchema) {
      super.setRequestHandler(requestSchema, handler);
      return;
    }
    super.setRequestHandler(requestSchema, async (request, extra) => {
      const result = await handler(request, extra);
      this.#negotiatedProtocolVersion = supportedProtocolVersion(
        (result as { readonly protocolVersion?: unknown }).protocolVersion,
      );
      return result;
    });
  }

  /**
   * Stateless HTTP requests carry their revision in the `MCP-Protocol-Version`
   * header, which the SDK transport has already validated; a request without
   * it uses the revision the specification assumes. A stdio request uses the
   * revision negotiated by `initialize`.
   */
  protocolVersionFor(extra: ServerRequestExtra): string {
    const headers = extra.requestInfo?.headers;
    const version =
      headers === undefined
        ? this.#negotiatedProtocolVersion
        : supportedProtocolVersion(headers["mcp-protocol-version"]);
    return version ?? DEFAULT_NEGOTIATED_PROTOCOL_VERSION;
  }
}
