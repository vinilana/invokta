// The counterpart of the sentinel scenario: an accepted `probe` invocation must
// reach the network, so the empty attempt list the scenario reports is evidence
// that nothing tried, not evidence that the sentinel cannot see the probe path.
import { createDeployContext, runProbe } from "../../dist/index.js";

const attempts = globalThis.__INVOKTA_DEPLOY_NETWORK_ATTEMPTS__;
if (!Array.isArray(attempts)) throw new Error("SENTINELS_NOT_INSTALLED");

const context = createDeployContext({
  cwd: process.cwd(),
  env: {},
  io: {
    writeStdout: () => undefined,
    writeStderr: () => undefined,
  },
});

const exitCode = await runProbe(
  ["--url", "http://127.0.0.1:1/mcp", "--timeout-ms", "1000"],
  context,
);

process.stdout.write(
  `${JSON.stringify({ exitCode, networkAttempts: attempts })}\n`,
);
