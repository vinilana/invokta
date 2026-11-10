import { pathToFileURL } from "node:url";

import type { ToolCandidate } from "./application/ports.js";
import { selectorFromEnvironment } from "./gateway-http.js";
import { createCrmEngine } from "./upstreams/crm-engine.js";

/**
 * Asks Jev which of the vendor's tools one task needs, without starting any
 * server: `npm run select-tools -- "cancel order O-42 and archive its invoice"`.
 * Prints the needed tools and their probabilities as JSON.
 */
async function main(): Promise<void> {
  const task = process.argv.slice(2).join(" ").trim();
  if (task === "") throw new Error("Pass the task as the argument.");
  const engine = createCrmEngine();
  const candidates: ToolCandidate[] = engine.list().map((summary) => ({
    id: summary.id,
    description: summary.description,
  }));
  const selected = await selectorFromEnvironment(process.env).select(
    task,
    candidates,
    { signal: AbortSignal.timeout(30_000) },
  );
  process.stdout.write(
    `${JSON.stringify({ task, tools: selected }, null, 2)}\n`,
  );
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  await main().catch((error: unknown) => {
    process.stderr.write(
      `select-tools failed: ${error instanceof Error ? error.message : "unexpected failure"}\n`,
    );
    process.exitCode = 1;
  });
}
