import { pathToFileURL } from "node:url";

import { createConfiguredObsidianContextEngine } from "./engine.js";
import { localPrincipal } from "./local-principal.js";

export async function main(
  args: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const query = args.join(" ").trim();
  if (query === "") throw new Error("A search query is required.");
  const result = await createConfiguredObsidianContextEngine().invoke(
    "obsidian.provide-context",
    { query },
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
    process.stderr.write("Obsidian context engine direct invocation failed.\n");
    process.exitCode = 1;
  });
}
