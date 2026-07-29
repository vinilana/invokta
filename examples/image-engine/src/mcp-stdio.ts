import { pathToFileURL } from "node:url";

import { serveMcpStdio } from "@ai-engine/mcp";

import { createConfiguredImageEngine } from "./engine.js";
import { localPrincipal } from "./local-principal.js";

export async function main(): Promise<void> {
  await serveMcpStdio(createConfiguredImageEngine(), {
    principal: localPrincipal,
  });
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  await main().catch(() => {
    process.stderr.write("Image engine MCP stdio adapter failed.\n");
    process.exitCode = 1;
  });
}
