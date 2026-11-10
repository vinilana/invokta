import { text } from "node:stream/consumers";
import { pathToFileURL } from "node:url";

import { hashApiKey } from "@invokta/gateway";

/**
 * Prints the SHA-256 digest of an API key read from stdin, for
 * `GATEWAY_API_KEYS`. The key is read from stdin, not an argument, so it does
 * not appear in the process list or shell history.
 */
async function main(): Promise<void> {
  const key = (await text(process.stdin)).replace(/\r?\n$/u, "");
  if (key === "") throw new Error("Pipe the API key on stdin.");
  process.stdout.write(`${await hashApiKey(key)}\n`);
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  await main().catch((error: unknown) => {
    process.stderr.write(
      `hash-key failed: ${error instanceof Error ? error.message : "unexpected failure"}\n`,
    );
    process.exitCode = 1;
  });
}
