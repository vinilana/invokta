import { pathToFileURL } from "node:url";

import { engine } from "./engine.js";
import { localPrincipal } from "./local-principal.js";

export async function main(): Promise<void> {
  const options = { source: "direct", principal: localPrincipal } as const;
  const classification = await engine.invoke(
    "operations.classify-ticket",
    { ticketId: "T-123" },
    options,
  );
  const reply = await engine.invoke(
    "operations.draft-reply",
    { ticketId: "T-123" },
    options,
  );
  process.stdout.write(`${JSON.stringify({ classification, reply })}\n`);
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  await main().catch(() => {
    process.stderr.write("Composed engine direct invocation failed.\n");
    process.exitCode = 1;
  });
}
