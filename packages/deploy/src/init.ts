import type { DeployContext, DeployExitCode } from "./io.js";
import { writeDiagnostic } from "./io.js";

/**
 * Scaffolds the deployment manifest and the production-shaped HTTP composition
 * root. The behavior is not implemented yet.
 */
export async function runInit(
  _args: readonly string[],
  context: DeployContext,
): Promise<DeployExitCode> {
  await writeDiagnostic(
    context,
    'The "init" command is not implemented yet.\n',
  );
  return 2;
}
