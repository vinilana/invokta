import type { Engine } from "@invokta/core";
import { expectTypeOf } from "vitest";

import { type CliIo, type RunCliOptions, runCli } from "../src/index.js";

declare const engine: Engine;
declare const io: CliIo;

expectTypeOf<
  CliIo["writeStdout"]
>().returns.toEqualTypeOf<void | Promise<void>>();
expectTypeOf<
  CliIo["writeStderr"]
>().returns.toEqualTypeOf<void | Promise<void>>();

expectTypeOf(
  runCli(engine, {
    argv: ["list"],
    principal: { id: "local:developer", attributes: { team: "support" } },
    signal: new AbortController().signal,
    io,
  }),
).toEqualTypeOf<Promise<number>>();

const options: RunCliOptions = {
  argv: ["run", "example.echo", "--stdin"],
  principal: null,
};
expectTypeOf(options).toMatchTypeOf<RunCliOptions>();

runCli(engine, {
  principal: null,
  // @ts-expect-error Identity can only enter through the trusted principal option.
  actor: "user:42",
});

// @ts-expect-error The trusted principal must be configured explicitly.
runCli(engine, { argv: ["list"] });
