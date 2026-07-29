import { pathToFileURL } from "node:url";

import { runCli } from "@ai-engine/cli";

import { createConfiguredImageEngine } from "./engine.js";
import { localPrincipal } from "./local-principal.js";

export async function main(): Promise<number> {
  return runCli(createConfiguredImageEngine(), { principal: localPrincipal });
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  process.exitCode = await main().catch(() => {
    process.stderr.write(
      '{"error":{"code":"EXECUTION_FAILED","message":"Image engine CLI startup failed."}}\n',
    );
    return 1;
  });
}
