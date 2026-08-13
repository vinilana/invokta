import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type AdapterId,
  type AdapterInvocationResult,
  type AdapterRunner,
  AdapterBusyError,
  adapterDescriptors,
  createAdapterRunner,
  isAdapterId,
} from "../src/adapter-runner.js";
import { startEngineHost } from "../src/engine-host.js";
import { loadEngineModule } from "../src/load-engine.js";
import {
  createPrincipalStore,
  type DevPrincipal,
} from "../src/principal-store.js";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const fixtureModule = "packages/devtools/test/fixtures/adapter-engine.js";
const devtoolsOrigin = "http://127.0.0.1:4100";
const adapters: readonly AdapterId[] = [
  "direct",
  "cli",
  "mcp-stdio",
  "mcp-http",
];
/** Four child processes plus module imports need more than the file default. */
const emulationTimeoutMs = 60_000;

let host: Awaited<ReturnType<typeof startEngineHost>>;
let runner: AdapterRunner;
let identity: DevPrincipal;

beforeAll(async () => {
  const loaded = await loadEngineModule({
    moduleSpecifier: fixtureModule,
    exportName: "engine",
    cwd: repositoryRoot,
  });
  if (loaded.kind !== "loaded") {
    throw new Error(
      `The adapter fixture engine failed to load: ${loaded.kind}`,
    );
  }
  const principals = createPrincipalStore();
  identity = principals.list()[0] as DevPrincipal;
  host = await startEngineHost({
    engine: loaded.engine,
    allowedOrigins: [devtoolsOrigin],
    authenticate: principals.authenticate,
  });
  runner = createAdapterRunner({
    module: { specifier: fixtureModule, exportName: "engine" },
    cwd: repositoryRoot,
    mcpEndpoint: () => `http://127.0.0.1:${String(host.address().port)}/mcp`,
  });
}, emulationTimeoutMs);

afterAll(async () => {
  await host.close();
});

function invoke(
  adapter: AdapterId,
  capabilityId: string,
  input: unknown,
  overrides: {
    readonly identity?: DevPrincipal | null;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
  } = {},
): Promise<AdapterInvocationResult> {
  const selected =
    overrides.identity === undefined ? identity : overrides.identity;
  return runner.run({
    adapter,
    capabilityId,
    mcpToolName: capabilityId.replaceAll(".", "_"),
    input,
    identity:
      selected === null
        ? null
        : { principal: selected.principal, token: selected.token },
    ...(overrides.timeoutMs === undefined
      ? {}
      : { timeoutMs: overrides.timeoutMs }),
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
  });
}

describe("adapter catalog", () => {
  it("publishes exactly the four execution sources", () => {
    expect(adapterDescriptors.map((entry) => entry.id)).toEqual([
      "direct",
      "cli",
      "mcp-stdio",
      "mcp-http",
    ]);
    for (const descriptor of adapterDescriptors) {
      expect(descriptor.source).toBe(descriptor.id);
    }
    expect(
      adapterDescriptors.find((entry) => entry.id === "mcp-http")?.identity,
    ).toBe("per-request");
    expect(isAdapterId("cli")).toBe(true);
    expect(isAdapterId("grpc")).toBe(false);
  });
});

describe("emulating one capability through every adapter", () => {
  it(
    "reaches the engine with the adapter's own source and the selected identity",
    async () => {
      const results = new Map<AdapterId, AdapterInvocationResult>();
      for (const adapter of adapters) {
        results.set(
          adapter,
          await invoke(adapter, "fixture.report", { marker: "hello" }),
        );
      }

      for (const [adapter, result] of results) {
        expect(result.outcome, `${adapter} outcome`).toBe("success");
        expect(result.result).toEqual({
          input: { marker: "hello" },
          source: adapter,
          principalId: identity.principal.id,
        });
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
      }
    },
    emulationTimeoutMs,
  );

  it(
    "reports the same capability error code from every adapter",
    async () => {
      for (const adapter of adapters) {
        const result = await invoke(adapter, "fixture.strict", {
          marker: 42,
        });
        expect(result.outcome, `${adapter} outcome`).toBe("capability-error");
        expect(result.error?.code, `${adapter} code`).toBe("INPUT_INVALID");
      }
    },
    emulationTimeoutMs,
  );

  it(
    "shows where each adapter establishes the principal",
    async () => {
      for (const adapter of ["direct", "cli", "mcp-stdio"] as const) {
        const result = await invoke(
          adapter,
          "fixture.guarded",
          {},
          {
            identity: null,
          },
        );
        expect(result.outcome, `${adapter} outcome`).toBe("capability-error");
        expect(result.error?.code, `${adapter} code`).toBe("UNAUTHENTICATED");
      }

      // The HTTP adapter authenticates per request, so an anonymous call never
      // reaches the invocation pipeline at all.
      const overHttp = await invoke(
        "mcp-http",
        "fixture.guarded",
        {},
        { identity: null },
      );
      expect(overHttp.outcome).toBe("adapter-error");
      expect(overHttp.error?.code).toBe("UNAUTHENTICATED");
      expect(
        overHttp.exchange.kind === "http" ? overHttp.exchange.status : 0,
      ).toBe(401);
    },
    emulationTimeoutMs,
  );
});

describe("what each adapter exchanged", () => {
  it(
    "records the command, exit code, and streams of a CLI emulation",
    async () => {
      const result = await invoke("cli", "fixture.report", { marker: "cli" });
      expect(result.exchange.kind).toBe("process");
      if (result.exchange.kind !== "process") return;
      expect(result.exchange.argv).toContain("run");
      expect(result.exchange.argv).toContain("fixture.report");
      expect(result.exchange.argv).toContain("--input");
      expect(result.exchange.command).toContain("cli-entry.js");
      // The command stays copy-pasteable: the JSON argument is shell-quoted.
      expect(result.exchange.command).toContain(`'{"marker":"cli"}'`);
      expect(result.exchange.exitCode).toBe(0);
      expect(result.exchange.stderr).toBe("");
      expect(JSON.parse(result.exchange.stdout) as unknown).toMatchObject({
        source: "cli",
      });
    },
    emulationTimeoutMs,
  );

  it(
    "records the tools/call frames of a stdio emulation",
    async () => {
      const result = await invoke("mcp-stdio", "fixture.report", {
        marker: "stdio",
      });
      expect(result.exchange.kind).toBe("mcp");
      if (result.exchange.kind !== "mcp") return;
      expect(result.exchange.transport).toBe("stdio");
      expect(result.exchange.target).toContain("stdio-entry.js");
      expect(JSON.parse(result.exchange.request) as unknown).toMatchObject({
        method: "tools/call",
        params: { name: "fixture_report" },
      });
      expect(result.exchange.response).toContain("structuredContent");
    },
    emulationTimeoutMs,
  );

  it(
    "records the request, status, and response body of an HTTP emulation",
    async () => {
      const result = await invoke("mcp-http", "fixture.report", {
        marker: "http",
      });
      expect(result.exchange.kind).toBe("http");
      if (result.exchange.kind !== "http") return;
      expect(result.exchange.status).toBe(200);
      expect(result.exchange.url).toContain("/mcp");
      expect(JSON.parse(result.exchange.requestBody) as unknown).toMatchObject({
        method: "tools/call",
      });
      expect(result.exchange.responseBody).toContain("structuredContent");
    },
    emulationTimeoutMs,
  );
});

describe("bounds", () => {
  it(
    "refuses more concurrent emulations than the configured cap",
    async () => {
      const bounded = createAdapterRunner({
        module: { specifier: fixtureModule, exportName: "engine" },
        cwd: repositoryRoot,
        mcpEndpoint: () =>
          `http://127.0.0.1:${String(host.address().port)}/mcp`,
        maxConcurrent: 1,
      });
      expect(bounded.maxConcurrent).toBe(1);

      const first = bounded.run({
        adapter: "direct",
        capabilityId: "fixture.report",
        mcpToolName: "fixture_report",
        input: {},
        identity: { principal: identity.principal, token: identity.token },
      });
      expect(bounded.active()).toBe(1);
      await expect(
        bounded.run({
          adapter: "direct",
          capabilityId: "fixture.report",
          mcpToolName: "fixture_report",
          input: {},
          identity: null,
        }),
      ).rejects.toBeInstanceOf(AdapterBusyError);
      await first;
      expect(bounded.active()).toBe(0);
    },
    emulationTimeoutMs,
  );

  it(
    "ends a child process that outlives its deadline",
    async () => {
      const result = await invoke(
        "direct",
        "fixture.report",
        {},
        {
          timeoutMs: 1,
        },
      );
      expect(result.outcome).toBe("adapter-error");
      expect(result.error?.code).toBe("TIMEOUT");
    },
    emulationTimeoutMs,
  );

  it(
    "reports a cancelled emulation",
    async () => {
      const controller = new AbortController();
      const pending = invoke(
        "direct",
        "fixture.report",
        {},
        {
          signal: controller.signal,
        },
      );
      controller.abort();
      const result = await pending;
      expect(result.outcome).toBe("adapter-error");
      expect(result.error?.code).toBe("CANCELLED");
    },
    emulationTimeoutMs,
  );

  it(
    "refuses a command-line payload the argument vector cannot carry",
    async () => {
      const huge = { marker: "x".repeat(200_000) };
      for (const adapter of ["direct", "cli"] as const) {
        const result = await invoke(adapter, "fixture.report", huge);
        expect(result.outcome, `${adapter} outcome`).toBe("adapter-error");
        expect(result.error?.code, `${adapter} code`).toBe(
          "ARGUMENTS_TOO_LARGE",
        );
        expect(result.error?.message).toContain("MCP adapter");
      }

      // The MCP adapters carry the same payload in the protocol instead.
      const overStdio = await invoke("mcp-stdio", "fixture.report", huge);
      expect(overStdio.outcome).toBe("success");
    },
    emulationTimeoutMs,
  );

  it(
    "reports an unreachable engine host instead of throwing",
    async () => {
      const offline = createAdapterRunner({
        module: { specifier: fixtureModule, exportName: "engine" },
        cwd: repositoryRoot,
        // Port 1 is never a devtools engine host on loopback.
        mcpEndpoint: () => "http://127.0.0.1:1/mcp",
      });
      const result = await offline.run({
        adapter: "mcp-http",
        capabilityId: "fixture.report",
        mcpToolName: "fixture_report",
        input: {},
        identity: { principal: identity.principal, token: identity.token },
      });
      expect(result.outcome).toBe("adapter-error");
      expect(result.error?.code).toBe("ENGINE_HOST_UNREACHABLE");
    },
    emulationTimeoutMs,
  );
});
