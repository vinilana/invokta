import { serveMcpStdio } from "@invokta/mcp";

import { engine, localPrincipal } from "./engine.js";

await serveMcpStdio(engine, { principal: localPrincipal });
