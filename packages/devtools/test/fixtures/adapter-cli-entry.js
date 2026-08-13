import { runCli } from "@invokta/cli";

import { engine } from "./adapter-engine.js";

/**
 * Stands in for a project's own `src/cli.ts`: its composition root fixes the
 * principal, the way every example in this repository does, so an emulation
 * that runs this entry point reports this identity rather than the one
 * selected in the interface.
 */
process.exitCode = await runCli(engine, {
  principal: { id: "project:composition-root" },
});
