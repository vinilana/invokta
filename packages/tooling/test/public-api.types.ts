import { expectTypeOf } from "vitest";

import {
  checkCapabilities,
  type CheckCapabilitiesIo,
  type CheckCapabilitiesOptions,
  checkMcp,
  type CheckMcpIo,
  type CheckMcpOptions,
} from "../src/index.js";

declare const io: CheckCapabilitiesIo;

expectTypeOf<
  CheckCapabilitiesIo["writeStderr"]
>().returns.toEqualTypeOf<void | Promise<void>>();

expectTypeOf(
  checkCapabilities({
    argv: [
      "check-capabilities",
      "dist/capabilities.js",
      "--export",
      "capabilities",
    ],
    cwd: "/workspace/app",
    io,
  }),
).toEqualTypeOf<Promise<number>>();

// The command reads the process argument vector and working directory by
// default, so every option is optional.
expectTypeOf(checkCapabilities()).toEqualTypeOf<Promise<number>>();

const options: CheckCapabilitiesOptions = {
  argv: ["check-capabilities", "dist/capabilities.js"],
};
expectTypeOf(options).toMatchTypeOf<CheckCapabilitiesOptions>();

// @ts-expect-error The command never writes to stdout, so there is no sink for it.
checkCapabilities({ io: { writeStdout: () => undefined } });

// @ts-expect-error An argument vector is a list of arguments, not a command line.
checkCapabilities({ argv: "check-capabilities dist/capabilities.js" });

declare const mcpIo: CheckMcpIo;
expectTypeOf(
  checkMcp({
    argv: ["check-mcp", "dist/engine.js"],
    cwd: "/workspace/app",
    io: mcpIo,
  }),
).toEqualTypeOf<Promise<number>>();
expectTypeOf(checkMcp()).toEqualTypeOf<Promise<number>>();

const mcpOptions: CheckMcpOptions = {
  argv: ["check-mcp", "dist/engine.js", "--export", "engine"],
};
expectTypeOf(mcpOptions).toMatchTypeOf<CheckMcpOptions>();

// @ts-expect-error The MCP checker never writes to stdout.
checkMcp({ io: { writeStdout: () => undefined } });

// @ts-expect-error An argument vector is a list of arguments, not a command line.
checkMcp({ argv: "check-mcp dist/engine.js" });
