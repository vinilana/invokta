import process from "node:process";
import type { Writable } from "node:stream";

import type { CapabilityMap, Engine, Principal } from "@ai-engine/core";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

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

import { createMcpServer } from "./protocol-server.js";
import { preserveFalsyRequestIds } from "./request-id-transport.js";

export interface ServeMcpStdioOptions {
  readonly principal?: Principal | null;
}

class CallbackStdioServerTransport extends StdioServerTransport {
  private readonly pendingSends = new Set<Promise<void>>();
  private closing: Promise<void> | undefined;

  constructor(private readonly output: Writable) {
    super(process.stdin, output);
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
  const server = createMcpServer(engine, {
    principal: options.principal ?? null,
    source: "mcp-stdio",
  });
  const transport = new CallbackStdioServerTransport(process.stdout);
  let resolveLifetime!: (failure: Error | undefined) => void;
  const lifetime = new Promise<Error | undefined>((resolve) => {
    resolveLifetime = resolve;
  });
  let closing: Promise<void> | undefined;

  const cleanup = (): void => {
    process.stdin.off("end", closeFromInput);
    process.stdin.off("close", closeFromInput);
    process.stdout.off("error", closeFromOutput);
  };
  const requestClose = (failure?: Error): void => {
    if (closing !== undefined) return;
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
