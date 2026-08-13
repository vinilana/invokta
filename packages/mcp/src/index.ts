import process from "node:process";
import type { Writable } from "node:stream";

import type { CapabilityMap, Engine, Principal } from "@invokta/core";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

export {
  beginMcpOAuthAuthorization,
  connectMcpClient,
  inspectMcpOAuth,
  type McpClientConnection,
  McpClientError,
  type McpClientErrorCode,
  type McpClientOperationOptions,
  type McpClientServerInfo,
  type McpClientTarget,
  type McpClientTool,
  type McpClientToolPage,
  type McpClientToolResult,
  type McpJsonValue,
  type McpOAuthAuthorization,
  type McpOAuthAuthorizationOptions,
  type McpOAuthClientTarget,
  type McpOAuthInspection,
  type McpOAuthStep,
  type McpOAuthStepName,
} from "./client.js";

export {
  type McpHttpAuthenticationRequest,
  type McpHttpAuthOptions,
  type McpHttpHeaderView,
  type McpHttpProtectedResourceMetadata,
  type McpHttpServerAddress,
  type McpHttpServerHandle,
  type ServeMcpHttpOptions,
  serveMcpHttp,
} from "./http.js";
export { toMcpToolName } from "./tool-name.js";
export {
  McpToolNameCollisionError,
  validateMcpToolCatalog,
} from "./protocol-server.js";

import { createMcpServer } from "./protocol-server.js";
import { preserveFalsyRequestIds } from "./request-id-transport.js";

export interface ServeMcpStdioOptions {
  readonly principal?: Principal | null;
  readonly maxReadBufferBytes?: number;
}

const DEFAULT_MAX_READ_BUFFER_BYTES = 10 * 1024 * 1024;

class CallbackStdioServerTransport extends StdioServerTransport {
  private readonly pendingSends = new Set<Promise<void>>();
  private closing: Promise<void> | undefined;

  constructor(
    private readonly output: Writable,
    maxReadBufferBytes: number,
  ) {
    super(process.stdin, output, { maxBufferSize: maxReadBufferBytes });
  }

  override send(message: JSONRPCMessage): Promise<void> {
    if (this.closing !== undefined) {
      return Promise.reject(new Error("The MCP stdio transport is closed."));
    }
    const pending = new Promise<void>((resolve, reject) => {
      this.output.write(serializeMessage(message), (error) => {
        if (error === undefined || error === null) resolve();
        else reject(error);
      });
    });
    this.pendingSends.add(pending);
    const forget = (): void => {
      this.pendingSends.delete(pending);
    };
    void pending.then(forget, forget);
    return pending;
  }

  override close(): Promise<void> {
    this.closing ??= this.closeOnce();
    return this.closing;
  }

  private async closeOnce(): Promise<void> {
    await super.close();
    if (!this.output.destroyed) {
      // Writable.destroy() does not interrupt an active libuv pipe write.
      const nativeHandle =
        this.pendingSends.size === 0
          ? undefined
          : (
              this.output as Writable & {
                readonly _handle?: { close(): void };
              }
            )._handle;
      this.output.destroy();
      nativeHandle?.close();
    }
    while (this.pendingSends.size > 0) {
      await Promise.allSettled([...this.pendingSends]);
    }
  }
}

function isBrokenPipe(error: Error): boolean {
  return (error as NodeJS.ErrnoException).code === "EPIPE";
}

export async function serveMcpStdio<Capabilities extends CapabilityMap>(
  engine: Engine<Capabilities>,
  options: ServeMcpStdioOptions = {},
): Promise<void> {
  const maxReadBufferBytes =
    options.maxReadBufferBytes ?? DEFAULT_MAX_READ_BUFFER_BYTES;
  if (!Number.isSafeInteger(maxReadBufferBytes) || maxReadBufferBytes <= 0) {
    throw new TypeError("maxReadBufferBytes must be a positive safe integer.");
  }
  const server = createMcpServer(engine, {
    principal: options.principal ?? null,
    source: "mcp-stdio",
  });
  const transport = new CallbackStdioServerTransport(
    process.stdout,
    maxReadBufferBytes,
  );
  let resolveLifetime!: (failure: Error | undefined) => void;
  const lifetime = new Promise<Error | undefined>((resolve) => {
    resolveLifetime = resolve;
  });
  let closing: Promise<void> | undefined;
  let closeRequested = false;

  const cleanup = (): void => {
    process.stdin.off("end", closeFromInput);
    process.stdin.off("close", closeFromInput);
    process.stdout.off("error", closeFromOutput);
  };
  const requestClose = (failure?: Error): void => {
    if (closeRequested) return;
    closeRequested = true;
    closing = (async () => {
      try {
        await server.close();
        resolveLifetime(
          failure === undefined || isBrokenPipe(failure) ? undefined : failure,
        );
      } catch (cause) {
        resolveLifetime(
          cause instanceof Error
            ? cause
            : new Error("Failed to close the MCP stdio server."),
        );
      } finally {
        cleanup();
      }
    })();
  };
  function closeFromInput(): void {
    requestClose();
  }
  function closeFromOutput(error: Error): void {
    requestClose(error);
  }

  let readBufferFailure: Error | undefined;
  server.onerror = (error) => {
    if (
      error.message ===
      `ReadBuffer exceeded maximum size of ${maxReadBufferBytes} bytes`
    ) {
      readBufferFailure = new Error(
        `The MCP stdio read buffer exceeded the configured limit of ${maxReadBufferBytes} bytes.`,
        { cause: error },
      );
    }
  };
  server.onclose = () => {
    requestClose(readBufferFailure);
    if (readBufferFailure !== undefined && !process.stdin.destroyed) {
      process.stdin.destroy();
    }
  };

  process.stdin.once("end", closeFromInput);
  process.stdin.once("close", closeFromInput);
  process.stdout.on("error", closeFromOutput);

  try {
    await server.connect(preserveFalsyRequestIds(transport));
    if (process.stdin.readableEnded || process.stdin.destroyed) requestClose();
    const failure = await lifetime;
    if (failure !== undefined) throw failure;
  } catch (cause) {
    requestClose();
    await closing;
    throw cause;
  } finally {
    cleanup();
  }
}
