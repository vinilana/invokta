import { serveMcpStdio } from "@invokta/mcp";

import { engine } from "./adapter-engine.js";

/**
 * Stands in for a project's own `src/mcp-stdio.ts` as `create-invokta-engine`
 * generates it: no principal at all, so an authenticated capability is denied
 * however the interface's identity is set.
 */
await serveMcpStdio(engine, { principal: null });
