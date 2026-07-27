import { serveMcpStdio } from "@ai-engine/mcp";

import { engine, localPrincipal } from "./engine.js";

await serveMcpStdio(engine, { principal: localPrincipal });
