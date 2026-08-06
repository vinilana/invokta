import { pathToFileURL } from "node:url";

import { engine } from "./engine.js";
import { toPrincipal } from "./identity/principal.js";
import {
  createApiKeyRegistryFromEnvironment,
  createApiKeyVerifier,
} from "./identity/verifier.js";

const credentialVariableName = "API_KEY_ENGINE_CREDENTIAL";

/**
 * The same verifier on a non-HTTP surface. A local channel has no request to
 * authenticate, so the composition root verifies the configured key once and
 * passes the resulting principal to invoke.
 */
export async function main(): Promise<void> {
  const credential = process.env[credentialVariableName];
  if (credential === undefined || credential === "") {
    throw new Error(`${credentialVariableName} is required.`);
  }

  const verifier = createApiKeyVerifier({
    registry: createApiKeyRegistryFromEnvironment(process.env),
  });
  const controller = new AbortController();
  const verified = await verifier.verify(credential, {
    signal: controller.signal,
  });
  if (verified === null) {
    // The rejected credential is never named, logged, or echoed.
    throw new Error(`${credentialVariableName} was rejected.`);
  }

  const result = await engine.invoke(
    "identity.whoami",
    {},
    { source: "direct", principal: toPrincipal(verified) },
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  await main().catch((error: unknown) => {
    const reason =
      error instanceof Error ? error.message : "an unexpected failure";
    process.stderr.write(
      `API key engine direct invocation failed: ${reason}\n`,
    );
    process.exitCode = 1;
  });
}
