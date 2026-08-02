import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const fixtures = new URL("./fixtures/", import.meta.url);

describe("Antigravity adapter no-I/O boundary", () => {
  it("maps, inspects, and patches while writes, processes, and network are forbidden", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        fileURLToPath(new URL("forbid-filesystem-writes.mjs", fixtures)),
        "--import",
        fileURLToPath(new URL("forbid-process-execution.mjs", fixtures)),
        "--import",
        fileURLToPath(new URL("forbid-network-access.mjs", fixtures)),
        fileURLToPath(
          new URL("antigravity-adapter-sentinel-scenario.mjs", fixtures),
        ),
      ],
      {
        cwd: fileURLToPath(new URL("../../..", import.meta.url)),
        encoding: "utf8",
        env: {
          ...process.env,
          ADAPTER_SECRET_SENTINEL: "DO_NOT_LEAK_ANTIGRAVITY_SECRET",
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain("FORBIDDEN");
    expect(result.stdout).not.toContain("DO_NOT_LEAK_ANTIGRAVITY_SECRET");
    expect(JSON.parse(result.stdout)).toMatchObject({
      metadata: {
        targetId: "antigravity",
        format: "json",
        toggleStrategy: "native-disabled",
      },
      http: {
        transport: "streamable-http",
        serverUrl: "https://support.example.com/mcp",
        disabled: false,
      },
      unsupported: {
        supported: false,
        reason: "antigravity-forward-env-unsupported",
      },
    });
  });
});
