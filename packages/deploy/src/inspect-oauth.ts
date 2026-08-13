import { DeployError, renderDeployDiagnostic } from "./errors.js";
import type { DeployContext, DeployExitCode } from "./io.js";
import { writeDiagnostic } from "./io.js";
import { inspectOAuthDiscovery } from "./oauth-inspection/inspect.js";
import { parseOAuthInspectionOptions } from "./oauth-inspection/options.js";

const invalidUsageText = 'Invalid arguments. Run "invokta-deploy --help".\n';

export async function runInspectOAuth(
  args: readonly string[],
  context: DeployContext,
): Promise<DeployExitCode> {
  const parsed = parseOAuthInspectionOptions(args);
  if (!parsed.ok) {
    await writeDiagnostic(context, invalidUsageText);
    return 2;
  }

  const result = await inspectOAuthDiscovery(parsed.options);
  if (!result.ok) {
    const error = new DeployError("OAUTH_INSPECTION_FAILED", {
      details: [
        `url: ${parsed.options.url.href}`,
        `stage: ${result.stage}`,
        `reason: ${result.reason}`,
      ],
    });
    await writeDiagnostic(context, renderDeployDiagnostic(error));
    return error.exitCode;
  }

  await writeDiagnostic(
    context,
    `OAUTH_INSPECTION_OK: OAuth discovery is ready.\n` +
      `  resource: ${result.resource}\n` +
      `  issuer: ${result.issuer}\n` +
      `  challenge-scopes: ${result.challengeScopes}\n` +
      `  registration: ${result.registration}\n` +
      `  jwks: ${result.jwks}\n`,
  );
  return 0;
}
