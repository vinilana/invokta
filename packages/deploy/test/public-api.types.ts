import { expectTypeOf } from "vitest";

import {
  type DeployCommandRun,
  type DeployContext,
  type DeployErrorCode,
  DeployError,
  type DeployExitCode,
  type DeployManifestIssue,
  type HttpDeployManifest,
  parseDeployManifest,
  runDeployCli,
} from "../src/index.js";
import {
  createMcpHttpScaffoldFiles,
  type McpHttpScaffoldFile,
  starterDeployManifest,
} from "../src/scaffold-public.js";

declare const context: DeployContext;

// Every orchestrating function resolves with an exit code and never exits.
expectTypeOf(runDeployCli()).toEqualTypeOf<Promise<DeployExitCode>>();
expectTypeOf<DeployExitCode>().toEqualTypeOf<0 | 1 | 2>();
expectTypeOf<DeployCommandRun>().toEqualTypeOf<
  (args: readonly string[], context: DeployContext) => Promise<DeployExitCode>
>();

// Diagnostics are the only sink a command may write to besides usage output.
expectTypeOf(
  context.io.writeStderr,
).returns.toEqualTypeOf<void | Promise<void>>();
expectTypeOf(context.env).toEqualTypeOf<
  Readonly<Record<string, string | undefined>>
>();

expectTypeOf(new DeployError("WRITE_FAILED").code).toEqualTypeOf<
  Readonly<DeployErrorCode>
>();
expectTypeOf(new DeployError("WRITE_FAILED").exitCode).toEqualTypeOf<
  Readonly<DeployExitCode>
>();

// A validated manifest carries every default already applied.
const result = parseDeployManifest("{}");
if (result.ok) {
  expectTypeOf(result.manifest).toEqualTypeOf<HttpDeployManifest>();
  expectTypeOf(result.manifest.schemaVersion).toEqualTypeOf<1>();
  expectTypeOf(result.manifest.image.port).toEqualTypeOf<number>();
  expectTypeOf(result.manifest.healthcheck.expect).toEqualTypeOf<
    "alive" | "ready"
  >();
} else {
  expectTypeOf(result.issues).toEqualTypeOf<readonly DeployManifestIssue[]>();
  expectTypeOf(result.code).toEqualTypeOf<
    "MANIFEST_NOT_FOUND" | "MANIFEST_INVALID"
  >();
}

// @ts-expect-error An argument vector is a list of arguments, not a command line.
runDeployCli({ argv: "probe --url https://engine.example/mcp" });

// @ts-expect-error The manifest is validated, so its shape is not writable.
parseDeployManifest("{}").ok = false;

// @ts-expect-error Only the specified error codes exist.
new DeployError("UNKNOWN_CODE");

expectTypeOf(createMcpHttpScaffoldFiles(starterDeployManifest)).toEqualTypeOf<
  readonly McpHttpScaffoldFile[]
>();
