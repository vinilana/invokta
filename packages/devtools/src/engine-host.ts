import type { Engine, InvokeOptions, Principal } from "@invokta/core";
import { EngineError } from "@invokta/core";
import type {
  McpHttpAuthenticationRequest,
  McpHttpServerHandle,
} from "@invokta/mcp";
import { serveMcpHttp } from "@invokta/mcp";

import type { LoadedEngine } from "./load-engine.js";

export interface InvocationRecord {
  readonly sequence: number;
  readonly capabilityId: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly outcome: "completed" | "failed";
  readonly errorCode?: string;
}

export interface StartEngineHostOptions {
  readonly engine: LoadedEngine;
  /** Defaults to an ephemeral loopback port. */
  readonly port?: number;
  /** The devtools interface origin, the only origin the host accepts. */
  readonly allowedOrigin: string;
  readonly authenticate: (
    request: McpHttpAuthenticationRequest,
  ) => Principal | null | Promise<Principal | null>;
  readonly onRecord?: (record: InvocationRecord) => void;
}

function readErrorCode(error: unknown): string | undefined {
  return error instanceof EngineError && typeof error.code === "string"
    ? error.code
    : undefined;
}

/**
 * Wraps the loaded engine in an observing delegate. The delegate forwards
 * every call unchanged — it never reads capability definitions, never
 * constructs a context, and never alters arguments, results, or errors — and
 * records timing and outcome after each invocation settles. A record consumer
 * failure cannot change the invocation result.
 */
function createObservingDelegate(
  engine: LoadedEngine,
  emit: (record: InvocationRecord) => void,
): Engine {
  let sequence = 0;

  const safeEmit = (record: InvocationRecord): void => {
    try {
      emit(record);
    } catch {
      // Observation is best-effort and must not change invocation behavior.
    }
  };

  return {
    name: engine.name,
    version: engine.version,
    list: () => engine.list(),
    describe: (capabilityId: string) => engine.describe(capabilityId),
    async invoke(
      capabilityId: string,
      input: unknown,
      options?: InvokeOptions,
    ): Promise<never> {
      sequence += 1;
      const startedAt = new Date().toISOString();
      const startedAtMs = performance.now();
      const durationMs = (): number =>
        Math.max(0, performance.now() - startedAtMs);
      try {
        const result = await engine.invoke(capabilityId, input, options);
        safeEmit({
          sequence,
          capabilityId,
          startedAt,
          durationMs: durationMs(),
          outcome: "completed",
        });
        return result as never;
      } catch (error) {
        const errorCode = readErrorCode(error);
        safeEmit({
          sequence,
          capabilityId,
          startedAt,
          durationMs: durationMs(),
          outcome: "failed",
          ...(errorCode === undefined ? {} : { errorCode }),
        });
        throw error;
      }
    },
  };
}

/**
 * Starts the engine host: the unmodified `serveMcpHttp` adapter bound to
 * loopback, serving the observing delegate with required bearer
 * authentication. Every capability execution reaches the engine through
 * `engine.invoke` with source `mcp-http`.
 */
export async function startEngineHost(
  options: StartEngineHostOptions,
): Promise<McpHttpServerHandle> {
  const delegate = createObservingDelegate(
    options.engine,
    options.onRecord ?? (() => undefined),
  );
  return serveMcpHttp(delegate, {
    host: "127.0.0.1",
    port: options.port ?? 0,
    allowedOrigins: [options.allowedOrigin],
    auth: { mode: "required", authenticate: options.authenticate },
  });
}
