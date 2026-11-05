import type { ExecutionContext } from "@invokta/core";

/** Delay between liveness reports while one provider request is pending. */
export const providerProgressIntervalMs = 15_000;

/**
 * Reports progress while the capability's single provider request is pending.
 *
 * The providers expose no completion percentage, so `progress` counts the
 * elapsed seconds and has no `total`. The first report is sent immediately and
 * each later one increases, which lets an MCP client that resets its request
 * timeout on progress keep waiting for a 150- to 180-second image request.
 */
export async function reportWhileProviderWorks<Value>(
  context: ExecutionContext,
  message: string,
  work: () => Promise<Value>,
): Promise<Value> {
  let elapsedSeconds = 0;
  context.reportProgress({ progress: elapsedSeconds, message });
  const heartbeat = setInterval(() => {
    elapsedSeconds += providerProgressIntervalMs / 1_000;
    context.reportProgress({ progress: elapsedSeconds, message });
  }, providerProgressIntervalMs);
  try {
    return await work();
  } finally {
    clearInterval(heartbeat);
  }
}
