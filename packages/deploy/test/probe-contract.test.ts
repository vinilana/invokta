import { describe, expect, it } from "vitest";

import { packageManagerStrategies } from "../src/generate/lockfile.js";
import { planGeneratedFiles } from "../src/generate/plan.js";
import { parseProjectPackage } from "../src/generate/project-package.js";
import { parseDeployManifest } from "../src/manifest.js";
import { probeTimeoutDefaultMs } from "../src/probe/options.js";
import { probeInitializeBody } from "../src/probe/request.js";

/**
 * `invokta-deploy probe` and the generated `deploy/healthcheck.mjs` are two
 * implementations of one semantic contract against the same endpoint. These
 * assertions compare the two surfaces directly, so a change to either one that
 * the other does not follow fails here rather than in a deployment.
 */
const project = parseProjectPackage(
  JSON.stringify({
    name: "contract-engine",
    version: "0.1.0",
    scripts: { build: "tsc -b" },
  }),
);

function healthcheckScript(): string {
  const result = parseDeployManifest(
    JSON.stringify({ schemaVersion: 1, entry: "dist/mcp-http.js" }),
  );
  if (!result.ok) throw new Error("the fixture manifest is invalid");
  const script = planGeneratedFiles({
    manifest: result.manifest,
    packageManager: packageManagerStrategies.npm,
    project,
  }).find((file) => file.path === "deploy/healthcheck.mjs");
  if (script === undefined) {
    throw new Error("no health-check script was planned");
  }
  return script.contents;
}

describe("the probe and the generated health check", () => {
  it("pin the same protocol revision", () => {
    const sent = JSON.parse(probeInitializeBody) as {
      readonly params: { readonly protocolVersion: string };
    };

    expect(healthcheckScript()).toContain(
      `const protocolVersion = ${JSON.stringify(sent.params.protocolVersion)};`,
    );
  });

  it("apply the same default deadline", () => {
    expect(healthcheckScript()).toContain(
      `const timeoutMs = ${String(probeTimeoutDefaultMs)};`,
    );
  });
});
