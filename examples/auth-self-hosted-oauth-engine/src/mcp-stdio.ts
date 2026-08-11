import { serveMcpStdio } from "@invokta/mcp";

import { engine } from "./engine.js";
import { localPrincipal } from "./local-principal.js";

await serveMcpStdio(engine, { principal: localPrincipal() });
