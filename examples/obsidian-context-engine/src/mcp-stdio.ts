import { pathToFileURL } from "node:url";

import { serveMcpStdio } from "@ai-engine/mcp";

import { createConfiguredObsidianContextEngine } from "./engine.js";
import { localPrincipal } from "./local-principal.js";

export async function main(): Promise<void> {
  await serveMcpStdio(createConfiguredObsidianContextEngine(), {
    principal: localPrincipal,
  });
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  await main().catch(() => {
    process.stderr.write("Obsidian context engine MCP stdio adapter failed.\n");
    process.exitCode = 1;
  });
}
