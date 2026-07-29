import { createEngine, defineCapability } from "@invokta/core";
import { type McpHttpServerHandle, serveMcpHttp } from "@invokta/mcp";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { runProbe } from "../src/probe.js";
import { createTestContext } from "./support/test-context.js";

/**
 * `@invokta/deploy` must never depend on a runtime package, so these imports
 * exist only in this test file and resolve through the workspace. They prove
 * the probe contract against the adapter the toolkit targets, not through a
 * stub that could drift from it.
 */
const secret = "sentinel-token-that-must-never-be-echoed";
const openServers: McpHttpServerHandle[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

function createProbeEngine() {
  return createEngine({
    name: "probe-integration-engine",
    version: "0.1.0",
    capabilities: {
      "support.echo": defineCapability({
        description: "Returns its input unchanged.",
        input: z.object({ value: z.string() }),
        output: z.object({ value: z.string() }),
        access: "authenticated",
        async run({ input }) {
          return { value: input.value };
        },
      }),
    },
  });
}

async function startEngine(
  overrides: Partial<Parameters<typeof serveMcpHttp>[1]> = {},
) {
  const server = await serveMcpHttp(createProbeEngine(), {
    port: 0,
    auth: {
      mode: "required",
      authenticate(request) {
        return request.headers.get("authorization") === `Bearer ${secret}`
          ? { id: "probe-principal" }
          : null;
      },
    },
    ...overrides,
  });
  openServers.push(server);
  const address = server.address();
  return {
    server,
    url: `http://127.0.0.1:${String(address.port)}/mcp`,
  };
}

async function probe(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
) {
  const harness = createTestContext({ env });
  const exitCode = await runProbe(args, harness.context);
  return { exitCode, stdout: harness.stdout, stderr: harness.stderr };
}

describe("runProbe against the real MCP HTTP adapter", () => {
  it("reports a required-auth endpoint as alive without holding a credential", async () => {
    const engine = await startEngine();

    const result = await probe(["--url", engine.url]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toEqual([]);
  });

  it("reports the endpoint as ready when the bearer variable holds a valid token", async () => {
    const engine = await startEngine();

    const result = await probe(
      ["--url", engine.url, "--expect", "ready", "--bearer-env", "PROBE_TOKEN"],
      { PROBE_TOKEN: secret },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toEqual([]);
  });

  it("reports the endpoint as unhealthy when the token is wrong", async () => {
    const engine = await startEngine();

    const result = await probe(
      ["--url", engine.url, "--expect", "ready", "--bearer-env", "PROBE_TOKEN"],
      { PROBE_TOKEN: "wrong-token" },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr.join("")).toContain("PROBE_UNHEALTHY");
    expect(result.stderr.join("")).toContain("status: 401");
    expect(result.stderr.join("")).not.toContain(secret);
    expect(result.stderr.join("")).not.toContain("wrong-token");
  });

  it("reports the endpoint as unhealthy when no credential is sent", async () => {
    const engine = await startEngine();

    const result = await probe(["--url", engine.url, "--expect", "ready"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.join("")).toContain("status: 401");
  });

  it("never leaks the token through a successful readiness probe", async () => {
    const engine = await startEngine();

    const result = await probe(
      ["--url", engine.url, "--expect", "ready", "--bearer-env", "PROBE_TOKEN"],
      { PROBE_TOKEN: secret },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.join("")).not.toContain(secret);
    expect(result.stderr.join("")).not.toContain(secret);
  });

  it("satisfies a Host allowlist that names only the public host", async () => {
    const engine = await startEngine({ allowedHosts: ["engine.example"] });

    const rejected = await probe(["--url", engine.url]);
    const accepted = await probe([
      "--url",
      engine.url,
      "--host-header",
      "engine.example",
    ]);

    expect(rejected.exitCode).toBe(1);
    expect(rejected.stderr.join("")).toContain("status: 403");
    expect(accepted.exitCode).toBe(0);
  });
});
