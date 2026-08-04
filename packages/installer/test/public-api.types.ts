import { expectTypeOf } from "vitest";

import {
  type RunEngineInstallerCliOptions,
  runEngineInstallerCli,
} from "../src/engine-cli.js";

const options: RunEngineInstallerCliOptions = {
  argv: ["install"],
  binaryName: "support-engine",
  packageRoot: "/opt/engines/support-engine",
};

expectTypeOf(runEngineInstallerCli(options)).toEqualTypeOf<
  Promise<0 | 1 | 2 | 130>
>();

const io = {
  inputIsTTY: () => true,
  outputIsTTY: () => true,
  writeStderr: (_text: string) => undefined,
  writeStdout: (_text: string) => undefined,
};

// @ts-expect-error Installer I/O is internal to the embedded command surface.
runEngineInstallerCli({ ...options, io });

runEngineInstallerCli({
  ...options,
  // @ts-expect-error Interactive session loading is not a public extension point.
  loadInteractiveSession: async () => 0,
});
