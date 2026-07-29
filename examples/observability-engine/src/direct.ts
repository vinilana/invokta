import { pathToFileURL } from "node:url";

import { createProviderBackedObservabilityEngine } from "./engine.js";
import { localPrincipal } from "./local-principal.js";

const defaultService = "checkout-api";
const defaultFrom = "2026-07-28T12:00:00.000Z";
const defaultTo = "2026-07-28T13:00:00.000Z";

export async function main(
  args: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const configuredLimit = args[3];
  const limit = configuredLimit === undefined ? 20 : Number(configuredLimit);
  const result = await createProviderBackedObservabilityEngine().invoke(
    "observability.collect-incident-context",
    {
      service: args[0] ?? defaultService,
      from: args[1] ?? defaultFrom,
      to: args[2] ?? defaultTo,
      limit,
    },
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
    process.stderr.write("Observability engine direct invocation failed.\n");
    process.exitCode = 1;
  });
}
