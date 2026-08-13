import { runCli } from "@invokta/cli";

import { engine } from "./engine.js";
import { localPrincipal } from "./local-principal.js";

process.exitCode = await runCli(engine, { principal: localPrincipal() });
