import { pathToFileURL } from "node:url";

import { engine } from "./engine.js";
import { localPrincipal } from "./local-principal.js";

export async function main(): Promise<void> {
  const result = await engine.invoke(
    "support.classify-ticket",
    { ticketId: "T-123" },
    { source: "direct", principal: localPrincipal },
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  await main().catch(() => {
    process.stderr.write("Support engine direct invocation failed.\n");
    process.exitCode = 1;
  });
}
