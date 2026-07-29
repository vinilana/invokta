import { pathToFileURL } from "node:url";

import { runCli } from "@ai-engine/cli";

import { engine } from "./engine.js";

export async function main(): Promise<number> {
  return runCli(engine, { principal: null });
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  process.exitCode = await main();
}
