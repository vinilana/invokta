#!/usr/bin/env node
import { runCli } from "@invokta/cli";

import {
  childUsageExitCode,
  loadChildEngine,
  readChildEngineArguments,
  readChildPrincipal,
} from "./child-context.js";

/**
 * The CLI emulation child: the published CLI adapter over the built module.
 * The command follows the module and export, so the exit code, standard
 * output, and standard error are exactly what a terminal would show.
 */

const args = readChildEngineArguments(process.argv.slice(2));
if (args === undefined) {
  process.stderr.write("The CLI adapter child requires a module and export.\n");
  process.exit(childUsageExitCode);
}

const engine = await loadChildEngine(args);
process.exitCode = await runCli(engine, {
  argv: args.rest,
  principal: readChildPrincipal(),
});
