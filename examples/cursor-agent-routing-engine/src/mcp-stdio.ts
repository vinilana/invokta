import { pathToFileURL } from "node:url";

import { serveMcpStdio } from "@ai-engine/mcp";

import { engine } from "./engine.js";

export async function main(): Promise<void> {
  await serveMcpStdio(engine, { principal: null });
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  await main().catch(() => {
    process.stderr.write("Cursor agent routing MCP stdio adapter failed.\n");
    process.exitCode = 1;
  });
}
