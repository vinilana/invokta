import { pathToFileURL } from "node:url";

import { createWhoamiRouteHandler } from "./embedded.js";
import type { AuthjsSession } from "./identity/principal.js";

/**
 * Runs the embedded surface without a Next.js server.
 *
 * The stub stands in for what `auth()` returns inside the host application;
 * every line after it is the code a real route handler runs.
 */
const demoSession: AuthjsSession = {
  expires: new Date(Date.now() + 3_600_000).toISOString(),
  user: {
    id: "user_2f1a",
    name: "Ada Lovelace",
    email: "ada@example.com",
    image: "https://cdn.example.com/avatars/ada.png",
  },
};

export const handleWhoami = createWhoamiRouteHandler({
  resolveSession: () => demoSession,
});

export async function main(): Promise<void> {
  const response = await handleWhoami(
    new Request("http://127.0.0.1/api/engine/whoami", { method: "POST" }),
  );
  process.stdout.write(`${await response.text()}\n`);
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  await main().catch(() => {
    process.stderr.write("Auth.js engine direct invocation failed.\n");
    process.exitCode = 1;
  });
}
