import { pathToFileURL } from "node:url";

import { runCli } from "@invokta/cli";

import { createDefaultAgentSessionEngine } from "./engine.js";
import { localPrincipal } from "./local-principal.js";

export async function main(): Promise<number> {
  return runCli(createDefaultAgentSessionEngine(), {
    principal: localPrincipal,
  });
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  process.exitCode = await main();
}
