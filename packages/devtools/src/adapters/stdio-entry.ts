#!/usr/bin/env node
import { serveMcpStdio } from "@invokta/mcp";

import {
  childUsageExitCode,
  loadChildEngine,
  readChildEngineArguments,
  readChildPrincipal,
} from "./child-context.js";

/**
 * The MCP stdio emulation child: the published stdio adapter over the built
 * module, with the selected development principal fixed at process start the
 * way a composition root fixes it. Standard output carries protocol frames
 * only, so every diagnostic goes to stderr.
 */

const args = readChildEngineArguments(process.argv.slice(2));
if (args === undefined) {
  process.stderr.write(
    "The stdio adapter child requires a module and export.\n",
  );
  process.exit(childUsageExitCode);
}

const engine = await loadChildEngine(args);
await serveMcpStdio(engine, { principal: readChildPrincipal() });
