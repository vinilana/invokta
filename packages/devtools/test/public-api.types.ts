import { expectTypeOf } from "vitest";

import {
  type DevtoolsIo,
  type DoctorReport,
  inspectEngine,
  type LoadedEngine,
  loadEngineModule,
  runDevtoolsCli,
  type RunDevtoolsCliOptions,
} from "../src/index.js";

declare const io: DevtoolsIo;
declare const engine: LoadedEngine;

expectTypeOf<
  DevtoolsIo["writeStderr"]
>().returns.toEqualTypeOf<void | Promise<void>>();

expectTypeOf(
  runDevtoolsCli({
    argv: ["doctor", "dist/engine.js", "--export", "engine"],
    cwd: "/workspace/app",
    io,
  }),
).toEqualTypeOf<Promise<number>>();

// The command reads the process argument vector and working directory by
// default, so every option is optional.
expectTypeOf(runDevtoolsCli()).toEqualTypeOf<Promise<number>>();

const options: RunDevtoolsCliOptions = {
  argv: ["doctor", "dist/engine.js"],
};
expectTypeOf(options).toMatchTypeOf<RunDevtoolsCliOptions>();

expectTypeOf(inspectEngine(engine)).toEqualTypeOf<DoctorReport>();
expectTypeOf(
  inspectEngine(engine, { mcpManifestPresent: true }),
).toEqualTypeOf<DoctorReport>();

expectTypeOf(
  loadEngineModule({
    moduleSpecifier: "dist/engine.js",
    exportName: "engine",
    cwd: "/workspace/app",
  }),
).resolves.toHaveProperty("kind");

// @ts-expect-error An argument vector is a list of arguments, not a command line.
runDevtoolsCli({ argv: "doctor dist/engine.js" });

// @ts-expect-error The inspection consumes an engine, not a module path.
inspectEngine("dist/engine.js");
