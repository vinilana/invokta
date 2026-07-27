import type { Engine, Principal } from "@ai-engine/core";
import { expectTypeOf } from "vitest";

import { type ServeMcpStdioOptions, serveMcpStdio } from "../src/index.js";

declare const engine: Engine;
declare const principal: Principal;

expectTypeOf(serveMcpStdio(engine, { principal })).toEqualTypeOf<
  Promise<void>
>();
expectTypeOf(serveMcpStdio(engine)).toEqualTypeOf<Promise<void>>();

const options: ServeMcpStdioOptions = { principal };
expectTypeOf(options).toEqualTypeOf<ServeMcpStdioOptions>();

serveMcpStdio(engine, {
  principal,
  // @ts-expect-error The public adapter does not accept MCP SDK transport objects.
  transport: {},
});
