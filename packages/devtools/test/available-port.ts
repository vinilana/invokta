import { createServer as createNetServer } from "node:net";

function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as { readonly port: number }).port;
      probe.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

function isAddressInUse(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EADDRINUSE"
  );
}

/**
 * Narrows the unavoidable close-then-bind race of ephemeral-port tests by
 * retrying only when another parallel test claimed the selected port first.
 */
export async function startOnAvailablePort<Value>(
  start: (port: number) => Promise<Value>,
): Promise<Value> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const port = await findAvailablePort();
    try {
      return await start(port);
    } catch (error) {
      if (!isAddressInUse(error)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}
