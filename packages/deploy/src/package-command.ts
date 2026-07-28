import type { DeployContext, DeployExitCode } from "./io.js";
import { writeDiagnostic } from "./io.js";

/**
 * Generates the deterministic deployment package for the project. The behavior
 * is not implemented yet.
 */
export async function runPackage(
  _args: readonly string[],
  context: DeployContext,
): Promise<DeployExitCode> {
  await writeDiagnostic(
    context,
    'The "package" command is not implemented yet.\n',
  );
  return 2;
}
