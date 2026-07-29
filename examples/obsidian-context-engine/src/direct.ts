import { pathToFileURL } from "node:url";

import { createConfiguredObsidianContextEngine } from "./engine.js";
import { localPrincipal } from "./local-principal.js";

export async function main(
  args: readonly string[] = process.argv.slice(2),
): Promise<void> {
  if (args.length > 1) throw new Error("At most one node ID is accepted.");
  const engine = createConfiguredObsidianContextEngine();
  const nodeId = args[0];
  const result =
    nodeId === undefined
      ? await engine.invoke(
          "knowledge.list-context-roots",
          {},
          { source: "direct", principal: localPrincipal },
        )
      : await engine.invoke(
          "knowledge.open-context-node",
          { id: nodeId },
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
