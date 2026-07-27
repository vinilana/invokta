import { runCli } from "@ai-engine/cli";

import { engine, localPrincipal } from "./engine.js";

process.exitCode = await runCli(engine, { principal: localPrincipal });
