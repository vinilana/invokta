import { pathToFileURL } from "node:url";

import { SupportHarness } from "./support-harness.js";

export async function main(
  args: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const [ticketId, ...extraArguments] = args;
  if (ticketId === undefined || ticketId === "" || extraArguments.length > 0) {
    throw new Error("Usage: support-harness <ticket-id>");
  }

  const harness = new SupportHarness();
  const snapshot = await harness.classifyTicket(ticketId);
  process.stdout.write(`${JSON.stringify(snapshot)}\n`);
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  await main().catch(() => {
    process.stderr.write("Support harness execution failed.\n");
    process.exitCode = 1;
  });
}
