import { DeployError, renderDeployDiagnostic } from "./errors.js";
import type { DeployContext, DeployExitCode } from "./io.js";
import { writeDiagnostic } from "./io.js";
import { classifyProbeExchange } from "./probe/classify.js";
import { parseProbeOptions } from "./probe/options.js";
import { sendProbeRequest } from "./probe/request.js";

// The same line the CLI writes for a rejected invocation. Nothing about a
// rejected argument or environment value is echoed, so a crafted value can
// neither forge a diagnostic line nor reach a log.
const invalidUsageText = 'Invalid arguments. Run "invokta-deploy --help".\n';

/**
 * Performs one bounded MCP liveness or readiness check against a running
 * endpoint. Exactly one `initialize` request is sent within the deadline, with
 * no retry, redirect, or connection reuse, and nothing is ever written to
 * `stdout`. A healthy endpoint produces no output at all, which keeps the
 * command usable as a container health check.
 */
export async function runProbe(
  args: readonly string[],
  context: DeployContext,
): Promise<DeployExitCode> {
  const parsed = parseProbeOptions(args, context.env);
  if (!parsed.ok) {
    await writeDiagnostic(context, invalidUsageText);
    return 2;
  }

  const exchange = await sendProbeRequest(parsed.options);
  const verdict = classifyProbeExchange(parsed.options.expect, exchange);
  if (verdict.healthy) return 0;

  // The target URL carries no userinfo, query, or fragment, so it is the only
  // caller-supplied text a probe diagnostic may repeat.
  const error = new DeployError(verdict.code, {
    details: [
      `url: ${parsed.options.url.href}`,
      ...(verdict.status === undefined
        ? []
        : [`status: ${String(verdict.status)}`]),
      `reason: ${verdict.reason}`,
    ],
  });
  await writeDiagnostic(context, renderDeployDiagnostic(error));
  return error.exitCode;
}
