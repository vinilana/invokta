import { pathToFileURL } from "node:url";

import { runCli } from "@invokta/cli";

import { createConfiguredObsidianContextEngine } from "./engine.js";
import { localPrincipal } from "./local-principal.js";

export async function main(): Promise<number> {
  return runCli(createConfiguredObsidianContextEngine(), {
    principal: localPrincipal,
  });
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  process.exitCode = await main().catch(() => {
    process.stderr.write(
      '{"error":{"code":"EXECUTION_FAILED","message":"Obsidian context engine CLI startup failed."}}\n',
    );
    return 1;
  });
}
