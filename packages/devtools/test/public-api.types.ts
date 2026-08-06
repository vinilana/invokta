import { expectTypeOf } from "vitest";

import {
  type DevtoolsIo,
  type DoctorReport,
  doctorReportToJson,
  inspectEngine,
  type LoadedEngine,
  loadEngineModule,
  type RunDevtoolsCliOptions,
  resolveVerifyTargetEnvironment,
  runDevtoolsCli,
  runMcpVerification,
  type VerifyEnvironmentError,
  type VerifyFailure,
  type VerifyRunResult,
} from "../src/index.js";

declare const io: DevtoolsIo;
declare const engine: LoadedEngine;
declare const report: DoctorReport;

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

// The JSON body keeps the report shape but erases thrown values.
expectTypeOf(doctorReportToJson(report)).toEqualTypeOf<unknown>();

expectTypeOf(
  loadEngineModule({
    moduleSpecifier: "dist/engine.js",
    exportName: "engine",
    cwd: "/workspace/app",
  }),
).resolves.toHaveProperty("kind");

// The MCP verification runner and the target environment resolver are part
// of the public surface together with their result and error types.
expectTypeOf(runMcpVerification).toBeFunction();
expectTypeOf(resolveVerifyTargetEnvironment).toBeFunction();
declare const verifyResult: VerifyRunResult;
declare const verifyFailure: VerifyFailure;
expectTypeOf(verifyResult).not.toBeUnknown();
expectTypeOf(verifyFailure).not.toBeUnknown();
declare const verifyError: VerifyEnvironmentError;
expectTypeOf(verifyError).toMatchTypeOf<Error>();

// @ts-expect-error An argument vector is a list of arguments, not a command line.
runDevtoolsCli({ argv: "doctor dist/engine.js" });

// @ts-expect-error The inspection consumes an engine, not a module path.
inspectEngine("dist/engine.js");
