import type { DeployContext, DeployExitCode } from "./io.js";
import { writeDiagnostic } from "./io.js";

/**
 * Performs one bounded MCP liveness or readiness check against a running
 * endpoint. The behavior is not implemented yet.
 */
export async function runProbe(
  _args: readonly string[],
  context: DeployContext,
): Promise<DeployExitCode> {
  await writeDiagnostic(
    context,
    'The "probe" command is not implemented yet.\n',
  );
  return 2;
}
