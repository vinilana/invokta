#!/usr/bin/env node
import { EngineError } from "@invokta/core";

import {
  childUsageExitCode,
  loadChildEngine,
  readChildEngineArguments,
  readChildPrincipal,
} from "./child-context.js";

/**
 * The direct-call emulation child: `engine.invoke` with source `direct` over
 * the built module, which is the shape a composition root or an embedding
 * application uses. The result is written to standard output and a structured
 * error to standard error, matching the CLI adapter's serialization so both
 * children report an engine failure the same way.
 */

function serialize(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function renderEngineError(error: EngineError): string {
  const publicDetails: unknown = error.publicDetails;
  return serialize({
    error: {
      code: error.code,
      message: error.message,
      ...(publicDetails === undefined ? {} : { publicDetails }),
    },
  });
}

const args = readChildEngineArguments(process.argv.slice(2));
const capabilityId = args?.rest[0];
const encodedInput = args?.rest[1];
if (
  args === undefined ||
  capabilityId === undefined ||
  capabilityId === "" ||
  encodedInput === undefined
) {
  process.stderr.write(
    "The direct adapter child requires a module, export, capability, and input.\n",
  );
  process.exit(childUsageExitCode);
}

let input: unknown;
try {
  input = JSON.parse(encodedInput);
} catch {
  process.stderr.write(
    serialize({
      error: { code: "INVALID_USAGE", message: "Input must be valid JSON." },
    }),
  );
  process.exit(childUsageExitCode);
}

const engine = await loadChildEngine(args);
try {
  const result = await engine.invoke(capabilityId, input as never, {
    source: "direct",
    principal: readChildPrincipal(),
  });
  process.stdout.write(serialize(result));
} catch (error) {
  process.stderr.write(
    error instanceof EngineError
      ? renderEngineError(error)
      : serialize({
          error: {
            code: "EXECUTION_FAILED",
            message: "The direct call failed.",
          },
        }),
  );
  process.exitCode = 1;
}
