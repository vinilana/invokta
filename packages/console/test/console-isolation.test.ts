import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const scenario = fileURLToPath(
  new URL("./fixtures/console-isolation-scenario.mjs", import.meta.url),
);
const networkSentinel = fileURLToPath(
  new URL("./fixtures/forbid-network-access.mjs", import.meta.url),
);
const processSentinel = fileURLToPath(
  new URL("./fixtures/forbid-process-execution.mjs", import.meta.url),
);

describe("console isolation sentinels", () => {
  it("reads and mutates without a network connection, a process launch, or an engine import", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", networkSentinel, "--import", processSentinel, scenario],
      { cwd: repositoryRoot, encoding: "utf8", env: { ...process.env } },
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);

    const report = JSON.parse(result.stdout) as {
      readonly discovered: readonly string[];
      readonly installed: string;
      readonly afterInstall: string;
      readonly removed: string;
      readonly configuration: string;
      readonly environmentReads: readonly string[];
    };

    expect(report.discovered).toEqual(["isolated"]);
    expect(report.installed).toBe("installed");
    expect(report.afterInstall).toBe("enabled");
    expect(report.removed).toBe("removed");
    // The engine entry point throws when executed; a clean run proves the
    // console only ever wrote its path.
    expect(report.configuration).toBe('{\n  "mcpServers": {}\n}\n');
    // Detection reads client home overrides by name; no value reaches a result.
    expect(report.environmentReads).not.toContain("PATH");
  });
});
