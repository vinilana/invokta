import { execFileSync, spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createEngine,
  defineCapability,
  type EngineSchema,
} from "@invokta/core";
import { serveMcpHttp } from "@invokta/mcp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadEngineModule } from "../src/load-engine.js";
import type { ServeHandles } from "../src/serve.js";
import { startServe } from "../src/serve.js";
import { startOnAvailablePort } from "./available-port.js";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const uiRoot = fileURLToPath(new URL("./fixtures/ui", import.meta.url));
/** The module adapter emulation children import, resolved against the cwd. */
const fixtureModule = {
  specifier: "packages/devtools/test/fixtures/adapter-engine.js",
  exportName: "engine",
} as const;

type FixtureValue = Readonly<Record<string, unknown>>;

const fixtureSchema = {
  "~standard": {
    version: 1,
    vendor: "invokta-devtools-test",
    validate: (value: unknown) => ({ value }),
    jsonSchema: {
      input: () => ({ type: "object" }),
      output: () => ({ type: "object" }),
    },
  },
} as unknown as EngineSchema<FixtureValue, FixtureValue>;

function buildEngine() {
  return createEngine({
    name: "server-test-engine",
    version: "0.1.0",
    capabilities: {
      "fixture.echo": defineCapability({
        title: "Fixture echo",
        description: "Echoes the fixture input.",
        annotations: { readOnly: true },
        input: fixtureSchema,
        output: fixtureSchema,
        access: "public",
        async run({ input }) {
          return { echoed: input };
        },
      }),
    },
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

async function readSse(
  url: string,
  minimumDataFrames: number,
  action?: () => Promise<void>,
  timeoutMs = 4000,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const response = await fetch(url, { signal: controller.signal });
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = "";
  if (action !== undefined) await action();
  try {
    while ((text.match(/\ndata: /g)?.length ?? 0) < minimumDataFrames) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    // The abort timeout ends a stream that never reached the minimum.
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
  return text;
}

describe("startServe", () => {
  const engine = buildEngine();
  let handles: ServeHandles;
  let base = "";
  let token = "";

  beforeAll(async () => {
    const result = await startOnAvailablePort((port) =>
      startServe({
        engine,
        cwd: repositoryRoot,
        module: fixtureModule,
        composedCapabilitiesExport: false,
        port,
        uiRoot,
      }),
    );
    if (result.kind !== "started") throw new Error("serve was refused");
    handles = result.handles;
    base = `http://127.0.0.1:${String(handles.devtoolsAddress.port)}`;

    const issued = await fetch(`${base}/api/principals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principal: { id: "tester" } }),
    });
    expect(issued.status).toBe(201);
    token = ((await issued.json()) as { token: string }).token;
  });

  afterAll(async () => {
    await handles?.close();
  });

  function callTool(headers: Readonly<Record<string, string>> = {}) {
    return fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "fixture_echo", arguments: { message: "hi" } },
      }),
    });
  }

  it("describes the engine on /api/engine", async () => {
    const response = await fetch(`${base}/api/engine`);

    expect(response.status).toBe(200);
    // Deliberately no adapter catalog: the interface owns the adapter
    // presentations, and publishing a second copy from the server would be
    // one more thing to keep in step by hand.
    expect(await response.json()).toEqual({
      name: "server-test-engine",
      version: "0.1.0",
      capabilityCount: 1,
      engineHost: { host: "127.0.0.1", port: handles.engineAddress.port },
      // The served module is published so the interface can propose the
      // conventional sibling path for a project entry point.
      module: fixtureModule,
    });
  });

  it("publishes full capability descriptions on /api/capabilities", async () => {
    const response = await fetch(`${base}/api/capabilities`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as ReadonlyArray<{
      readonly id: string;
      readonly mcpToolName: string;
      readonly inputSchema: unknown;
      readonly outputSchema: unknown;
    }>;
    expect(body).toHaveLength(1);
    expect(body[0]?.id).toBe("fixture.echo");
    expect(body[0]?.mcpToolName).toBe("fixture_echo");
    expect(body[0]?.inputSchema).toEqual({ type: "object" });
    expect(body[0]?.outputSchema).toEqual({ type: "object" });
  });

  it("serves the doctor report on /api/doctor", async () => {
    const response = await fetch(`${base}/api/doctor`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly engineName: string;
      readonly findings: readonly unknown[];
      readonly notes: ReadonlyArray<{ readonly code: string }>;
    };
    expect(body.engineName).toBe("server-test-engine");
    expect(body.findings).toEqual([]);
    expect(body.notes.map((note) => note.code)).toContain(
      "MCP_MANIFEST_MISSING",
    );
  });

  it("lists principals without exposing tokens", async () => {
    const response = await fetch(`${base}/api/principals`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as ReadonlyArray<
      Readonly<Record<string, unknown>>
    >;
    expect(body.length).toBeGreaterThanOrEqual(2);
    for (const entry of body) {
      expect(Object.keys(entry).sort()).toEqual(["key", "principal"]);
    }
  });

  it("rotates and removes principals through the API", async () => {
    const issued = await fetch(`${base}/api/principals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principal: { id: "rotating" } }),
    });
    const created = (await issued.json()) as {
      readonly key: string;
      readonly token: string;
    };

    const rotated = await fetch(`${base}/api/principals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: created.key }),
    });
    expect(rotated.status).toBe(200);
    const rotatedBody = (await rotated.json()) as { readonly token: string };
    expect(rotatedBody.token).not.toBe(created.token);

    const removed = await fetch(`${base}/api/principals`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: created.key }),
    });
    expect(removed.status).toBe(200);

    const removedAgain = await fetch(`${base}/api/principals`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: created.key }),
    });
    expect(removedAgain.status).toBe(404);
  });

  it("updates a principal in place through the API", async () => {
    const issued = await fetch(`${base}/api/principals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principal: { id: "editable" } }),
    });
    const created = (await issued.json()) as {
      readonly key: string;
      readonly token: string;
    };

    const updated = await fetch(`${base}/api/principals`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key: created.key,
        principal: {
          id: "editable",
          attributes: { permissions: ["ticket:read"] },
        },
      }),
    });
    expect(updated.status).toBe(200);
    const updatedBody = (await updated.json()) as Readonly<
      Record<string, unknown>
    >;
    // An update mints nothing, so it answers without a credential.
    expect(Object.keys(updatedBody).sort()).toEqual(["key", "principal"]);
    expect(updatedBody.principal).toEqual({
      id: "editable",
      attributes: { permissions: ["ticket:read"] },
    });

    const listed = (await (
      await fetch(`${base}/api/principals`)
    ).json()) as ReadonlyArray<{
      readonly key: string;
      readonly principal: unknown;
    }>;
    expect(listed.find(({ key }) => key === created.key)?.principal).toEqual({
      id: "editable",
      attributes: { permissions: ["ticket:read"] },
    });

    const unknownKey = await fetch(`${base}/api/principals`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key: "p_absent",
        principal: { id: "editable" },
      }),
    });
    expect(unknownKey.status).toBe(404);
    expect((await unknownKey.json()) as unknown).toMatchObject({
      error: "unknown_principal",
    });

    const invalidPrincipal = await fetch(`${base}/api/principals`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: created.key, principal: { id: "" } }),
    });
    expect(invalidPrincipal.status).toBe(400);
    expect((await invalidPrincipal.json()) as unknown).toMatchObject({
      error: "invalid_principal",
    });

    const removed = await fetch(`${base}/api/principals`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: created.key }),
    });
    expect(removed.status).toBe(200);
  });

  it("proxies an authenticated tools/call to the engine host", async () => {
    const response = await callTool({ authorization: `Bearer ${token}` });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly result: { readonly structuredContent: unknown };
    };
    expect(body.result.structuredContent).toEqual({
      echoed: { message: "hi" },
    });
  });

  it("passes the engine host's 401 challenge through unchanged", async () => {
    const response = await callTool();

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("rejects a foreign-origin POST before proxying", async () => {
    const response = await callTool({
      authorization: `Bearer ${token}`,
      origin: "http://attacker.example",
    });

    expect(response.status).toBe(403);
  });

  it("rejects a foreign Host header", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        {
          host: "127.0.0.1",
          port: handles.devtoolsAddress.port,
          path: "/api/engine",
          method: "GET",
          headers: { host: "attacker.example" },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.once("error", reject);
      request.end();
    });

    expect(status).toBe(403);
  });

  it("never emits Access-Control headers", async () => {
    const responses = await Promise.all([
      fetch(`${base}/`),
      fetch(`${base}/api/engine`),
      fetch(`${base}/api/capabilities`),
      fetch(`${base}/api/doctor`),
      fetch(`${base}/api/principals`),
      callTool({ authorization: `Bearer ${token}` }),
      fetch(`${base}/unknown`),
    ]);

    for (const response of responses) {
      for (const name of response.headers.keys()) {
        expect(name.toLowerCase().startsWith("access-control-")).toBe(false);
      }
    }
  });

  it("serves the interface bundle and refuses traversal", async () => {
    const index = await fetch(`${base}/`);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("fixture-interface-page");

    const asset = await fetch(`${base}/assets/app.js`);
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain("fixture-interface-script");

    const traversal = await fetch(`${base}/assets/..%2Fserver.test.ts`);
    expect(traversal.status).toBe(404);
    const missing = await fetch(`${base}/assets/absent.js`);
    expect(missing.status).toBe(404);
  });

  it("streams trace entries over /api/events", async () => {
    const text = await readSse(`${base}/api/events`, 2, async () => {
      const response = await callTool({ authorization: `Bearer ${token}` });
      await response.arrayBuffer();
    });

    expect(text).toContain("event: trace");
    expect(text).toContain('"kind":"invocation"');
    expect(text).toContain('"kind":"exchange"');
    expect(text).toContain('"capabilityId":"fixture.echo"');
  });

  it("clears the trace buffer and offers no export route", async () => {
    const call = await callTool({ authorization: `Bearer ${token}` });
    await call.arrayBuffer();

    // ADR 0021 keeps the trace in memory: there is no export route at all.
    const exported = await fetch(`${base}/api/trace/export`);
    expect(exported.status).toBe(404);

    const wrongMethod = await fetch(`${base}/api/trace/clear`);
    expect(wrongMethod.status).toBe(405);

    const foreignOrigin = await fetch(`${base}/api/trace/clear`, {
      method: "POST",
      headers: { origin: "http://attacker.example" },
    });
    expect(foreignOrigin.status).toBe(403);

    const cleared = await fetch(`${base}/api/trace/clear`, { method: "POST" });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ cleared: true });

    // The replay of a fresh stream carries nothing until the next exchange.
    const replay = await readSse(`${base}/api/events`, 1, async () => {
      const next = await callTool({ authorization: `Bearer ${token}` });
      await next.arrayBuffer();
    });
    expect(replay.match(/\ndata: /g)?.length ?? 0).toBeLessThanOrEqual(2);
  });

  it("responds 404 on unknown routes and 405 on wrong methods", async () => {
    const unknown = await fetch(`${base}/unknown`);
    expect(unknown.status).toBe(404);

    const wrongMethod = await fetch(`${base}/api/engine`, { method: "POST" });
    expect(wrongMethod.status).toBe(405);

    const wrongMcp = await fetch(`${base}/mcp`);
    expect(wrongMcp.status).toBe(405);
  });
});

describe("adapter emulation over /api/invoke", () => {
  let handles: ServeHandles;
  let base = "";
  let principalKey = "";
  let principalId = "";
  /** The same engine the dev server loaded, for the external-endpoint test. */
  let fixtureEngine: Parameters<typeof serveMcpHttp>[0];
  /** Four child processes and one HTTP round trip need room to settle. */
  const emulationTimeoutMs = 60_000;

  beforeAll(async () => {
    const loaded = await loadEngineModule({
      moduleSpecifier: fixtureModule.specifier,
      exportName: fixtureModule.exportName,
      cwd: repositoryRoot,
    });
    if (loaded.kind !== "loaded") {
      throw new Error(`The adapter fixture failed to load: ${loaded.kind}`);
    }
    fixtureEngine = loaded.engine as unknown as Parameters<
      typeof serveMcpHttp
    >[0];
    const result = await startOnAvailablePort((port) =>
      startServe({
        engine: loaded.engine,
        cwd: repositoryRoot,
        module: fixtureModule,
        composedCapabilitiesExport: false,
        port,
        uiRoot,
      }),
    );
    if (result.kind !== "started") throw new Error("serve was refused");
    handles = result.handles;
    base = `http://127.0.0.1:${String(handles.devtoolsAddress.port)}`;
    const principals = (await (
      await fetch(`${base}/api/principals`)
    ).json()) as ReadonlyArray<{
      readonly key: string;
      readonly principal: { readonly id: string };
    }>;
    principalKey = principals[0]?.key ?? "";
    principalId = principals[0]?.principal.id ?? "";
  }, emulationTimeoutMs);

  afterAll(async () => {
    await handles.close();
  });

  function invoke(body: unknown): Promise<Response> {
    return fetch(`${base}/api/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it(
    "runs the same capability through every adapter",
    async () => {
      for (const adapter of [
        "direct",
        "cli",
        "mcp-stdio",
        "mcp-http",
      ] as const) {
        const response = await invoke({
          adapter,
          capabilityId: "fixture.report",
          arguments: { marker: adapter },
          principalKey,
        });

        expect(response.status, `${adapter} status`).toBe(200);
        const body = (await response.json()) as {
          readonly adapter: string;
          readonly outcome: string;
          readonly durationMs: number;
          readonly result: { readonly source: string };
          readonly exchange: { readonly kind: string };
        };
        expect(body.adapter).toBe(adapter);
        expect(body.outcome, `${adapter} outcome`).toBe("success");
        expect(body.result.source).toBe(adapter);
        expect(body.durationMs).toBeGreaterThanOrEqual(0);
        expect(body.exchange.kind).toBe(
          adapter === "mcp-http"
            ? "http"
            : adapter === "mcp-stdio"
              ? "mcp"
              : "process",
        );
      }
    },
    emulationTimeoutMs,
  );

  it(
    "records one adapter entry per emulation in the trace",
    async () => {
      const text = await readSse(`${base}/api/events`, 1, async () => {
        const response = await invoke({
          adapter: "direct",
          capabilityId: "fixture.report",
          arguments: {},
          principalKey,
        });
        await response.arrayBuffer();
      });

      expect(text).toContain('"kind":"adapter"');
      expect(text).toContain('"adapter":"direct"');
      expect(text).toContain('"capabilityId":"fixture.report"');
    },
    emulationTimeoutMs,
  );

  it(
    "records the identity an emulated call acted as",
    async () => {
      // A cleared buffer keeps the replay empty, so the stream carries only
      // the two emulations this test provokes.
      await (await fetch(`${base}/api/trace/clear`, { method: "POST" })).json();
      const text = await readSse(`${base}/api/events`, 2, async () => {
        const named = await invoke({
          adapter: "direct",
          capabilityId: "fixture.report",
          arguments: {},
          principalKey,
        });
        await named.arrayBuffer();
        const anonymous = await invoke({
          adapter: "direct",
          capabilityId: "fixture.report",
          arguments: {},
        });
        await anonymous.arrayBuffer();
      });

      expect(text).toContain(`"principalId":${JSON.stringify(principalId)}`);
      expect(text).toContain('"principalId":null');
    },
    emulationTimeoutMs,
  );

  it(
    "sends MCP HTTP wherever the selected target points",
    async () => {
      // A second engine host stands in for the developer's own HTTP entry
      // point: a real endpoint with its own authentication hook.
      const external = await serveMcpHttp(fixtureEngine, {
        host: "127.0.0.1",
        port: 0,
        allowedOrigins: ["http://127.0.0.1:4100"],
        auth: {
          mode: "required",
          authenticate: (authRequest) =>
            authRequest.headers.get("x-api-key") === "external-key"
              ? { id: "external:client" }
              : null,
        },
      });
      const url = `http://127.0.0.1:${String(external.address().port)}/mcp`;
      try {
        const selected = await fetch(`${base}/api/http-target`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "external",
            url,
            authentication: {
              type: "headers",
              headers: [
                {
                  name: "X-API-Key",
                  value: { kind: "literal", value: "external-key" },
                },
              ],
            },
          }),
        });
        expect(selected.status).toBe(200);
        // The credential never comes back out of the dev server.
        const view = await selected.text();
        expect(view).not.toContain("external-key");
        expect(JSON.parse(view) as unknown).toEqual({
          kind: "external",
          url,
          authentication: { type: "headers", headerNames: ["X-API-Key"] },
        });

        const response = await invoke({
          adapter: "mcp-http",
          capabilityId: "fixture.report",
          arguments: { marker: "external" },
          principalKey,
        });
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          readonly outcome: string;
          readonly result: unknown;
          readonly exchange: {
            readonly kind: string;
            readonly target?: string;
          };
        };
        expect(body.outcome).toBe("success");
        // The endpoint's own hook decided the principal, not the devtools
        // identity: that is what an external boundary means.
        expect(body.result).toEqual({
          input: { marker: "external" },
          source: "mcp-http",
          principalId: "external:client",
        });
        expect(body.exchange.kind).toBe("mcp");
        expect(body.exchange.target).toBe(url);

        // A wrong credential is the endpoint's own rejection, not ours.
        await fetch(`${base}/api/http-target`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "external",
            url,
            authentication: { type: "none" },
          }),
        });
        const rejected = await invoke({
          adapter: "mcp-http",
          capabilityId: "fixture.report",
          arguments: {},
          principalKey,
        });
        expect(
          ((await rejected.json()) as { readonly outcome: string }).outcome,
        ).toBe("adapter-error");
      } finally {
        await fetch(`${base}/api/http-target`, { method: "DELETE" });
        await external.close();
      }
    },
    emulationTimeoutMs,
  );

  it(
    "keeps the devtools host reachable without a credential ceremony",
    async () => {
      const anonymous = await fetch(`${base}/api/http-target`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "devtools",
          authentication: { type: "none" },
        }),
      });
      expect(anonymous.status).toBe(200);
      try {
        // No Authorization header reaches the host, so it answers its own
        // fail-closed challenge before the engine runs.
        const overHttp = await invoke({
          adapter: "mcp-http",
          capabilityId: "fixture.report",
          arguments: {},
          principalKey,
        });
        const body = (await overHttp.json()) as {
          readonly outcome: string;
          readonly error: { readonly code: string };
          readonly exchange: { readonly status: number };
        };
        expect(body.outcome).toBe("adapter-error");
        expect(body.error.code).toBe("UNAUTHENTICATED");
        expect(body.exchange.status).toBe(401);

        // The three process adapters never had a credential to withhold.
        for (const adapter of ["direct", "cli", "mcp-stdio"] as const) {
          const response = await invoke({
            adapter,
            capabilityId: "fixture.report",
            arguments: {},
            principalKey,
          });
          expect(
            ((await response.json()) as { readonly outcome: string }).outcome,
            `${adapter} outcome`,
          ).toBe("success");
        }
      } finally {
        await fetch(`${base}/api/http-target`, { method: "DELETE" });
      }
    },
    emulationTimeoutMs,
  );

  it(
    "runs the project's own composition root when its entry point is selected",
    async () => {
      // The devtools child supplies the identity the interface selected; a
      // project entry point supplies whatever its own root decides. The same
      // call answers differently, and selecting the entry point is what makes
      // that visible instead of surprising.
      const asDevtools = await invoke({
        adapter: "cli",
        capabilityId: "fixture.report",
        arguments: {},
        principalKey,
      });
      expect(
        (
          (await asDevtools.json()) as {
            readonly result: { principalId: string };
          }
        ).result.principalId,
      ).toBe("local-dev");

      const selected = await fetch(`${base}/api/entry-target`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          adapter: "cli",
          entryPoint: {
            kind: "project",
            path: "packages/devtools/test/fixtures/adapter-cli-entry.js",
          },
        }),
      });
      expect(selected.status).toBe(200);
      expect((await selected.json()) as unknown).toEqual({
        cli: {
          kind: "project",
          path: "packages/devtools/test/fixtures/adapter-cli-entry.js",
        },
        "mcp-stdio": { kind: "devtools" },
      });

      try {
        const asProject = await invoke({
          adapter: "cli",
          capabilityId: "fixture.report",
          arguments: {},
          principalKey,
        });
        const body = (await asProject.json()) as {
          readonly outcome: string;
          readonly result: { readonly principalId: string };
          readonly exchange: { readonly command: string };
        };
        expect(body.outcome).toBe("success");
        expect(body.result.principalId).toBe("project:composition-root");
        // The reproduction command is the command the developer would type.
        expect(body.exchange.command).toContain(
          "adapter-cli-entry.js run fixture.report",
        );
        expect(body.exchange.command).not.toContain("adapters/cli-entry.js");

        // MCP stdio still runs the devtools child until it is selected too.
        const stdio = await invoke({
          adapter: "mcp-stdio",
          capabilityId: "fixture.report",
          arguments: {},
          principalKey,
        });
        expect(
          ((await stdio.json()) as { readonly result: { principalId: string } })
            .result.principalId,
        ).toBe("local-dev");
      } finally {
        await fetch(`${base}/api/entry-target`, { method: "DELETE" });
      }
    },
    emulationTimeoutMs,
  );

  it(
    "requires no credential when the project's root supplies none",
    async () => {
      await fetch(`${base}/api/entry-target`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          adapter: "mcp-stdio",
          entryPoint: {
            kind: "project",
            path: "packages/devtools/test/fixtures/adapter-stdio-entry.js",
          },
        }),
      });
      try {
        // The generated starter serves stdio with `principal: null`, so an
        // authenticated capability is denied however the identity is set —
        // which is the behavior the developer ships.
        const guarded = await invoke({
          adapter: "mcp-stdio",
          capabilityId: "fixture.guarded",
          arguments: {},
          principalKey,
        });
        const body = (await guarded.json()) as {
          readonly outcome: string;
          readonly error: { readonly code: string };
        };
        expect(body.outcome).toBe("capability-error");
        expect(body.error.code).toBe("UNAUTHENTICATED");

        // A public capability needs no credential on that same path.
        const open = await invoke({
          adapter: "mcp-stdio",
          capabilityId: "fixture.report",
          arguments: {},
          principalKey,
        });
        const reported = (await open.json()) as {
          readonly outcome: string;
          readonly result: { readonly principalId: string | null };
        };
        expect(reported.outcome).toBe("success");
        expect(reported.result.principalId).toBeNull();
      } finally {
        await fetch(`${base}/api/entry-target`, { method: "DELETE" });
      }
    },
    emulationTimeoutMs,
  );

  it("keeps an entry point inside the project it serves", async () => {
    const outside = await fetch(`${base}/api/entry-target`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        adapter: "cli",
        entryPoint: { kind: "project", path: "../../etc/passwd" },
      }),
    });
    expect(outside.status).toBe(400);
    expect((await outside.json()) as unknown).toMatchObject({
      error: "invalid_entry_point",
    });

    const unknownAdapter = await fetch(`${base}/api/entry-target`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        adapter: "direct",
        entryPoint: { kind: "project", path: "dist/direct.js" },
      }),
    });
    // A direct entry point has no invocation contract to reuse.
    expect(unknownAdapter.status).toBe(400);
    expect((await unknownAdapter.json()) as unknown).toMatchObject({
      error: "invalid_adapter",
    });

    const wrongMethod = await fetch(`${base}/api/entry-target`, {
      method: "POST",
    });
    expect(wrongMethod.status).toBe(405);

    const view = await fetch(`${base}/api/entry-target`);
    expect((await view.json()) as unknown).toEqual({
      cli: { kind: "devtools" },
      "mcp-stdio": { kind: "devtools" },
    });
  });

  it("checks the drafted OAuth endpoint without committing a target", async () => {
    // The check binds to the exact URL the caller drafted, so an endpoint can
    // be inspected before it is ever selected — no browser tab required.
    const drafted = `http://127.0.0.1:${String(handles.engineAddress.port)}/mcp`;
    const checked = await fetch(`${base}/api/http-target/check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: drafted }),
    });
    expect(checked.status).toBe(200);
    const inspection = (await checked.json()) as {
      readonly ready: boolean;
      readonly steps: ReadonlyArray<{
        readonly name: string;
        readonly outcome: string;
      }>;
    };
    // The engine host challenges but publishes no OAuth metadata, so the
    // chain reports which leg failed rather than authorizing anything.
    expect(inspection.ready).toBe(false);
    expect(inspection.steps.map(({ name }) => name)).toEqual([
      "challenge",
      "resource-metadata",
      "authorization-server-metadata",
      "registration",
    ]);

    // Without a drafted URL, the stored devtools target has no OAuth chain.
    const stored = await fetch(`${base}/api/http-target/check`, {
      method: "POST",
    });
    expect(stored.status).toBe(400);
    expect((await stored.json()) as unknown).toMatchObject({
      error: "not_an_external_endpoint",
    });
  });

  it("redirects the OAuth callback to a clean result path before rendering", async () => {
    // ADR 0023: the authorization code and state must not stay in the address
    // bar or history, so nothing renders at the callback URL itself.
    const callback = await fetch(
      `${base}/oauth/callback?state=${"a".repeat(43)}&code=one-time-code`,
      { redirect: "manual" },
    );
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe(
      "/oauth/result?outcome=error",
    );

    const result = await fetch(`${base}/oauth/result?outcome=success`);
    expect(result.status).toBe(200);
    expect(await result.text()).toContain("Authorization complete");

    const unknownOutcome = await fetch(`${base}/oauth/result?outcome=weird`);
    expect(await unknownOutcome.text()).toContain("Authorization failed");
  });

  it("refuses a target the devtools host could never honor", async () => {
    const unknownKind = await fetch(`${base}/api/http-target`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "smtp" }),
    });
    expect(unknownKind.status).toBe(400);
    expect((await unknownKind.json()) as unknown).toMatchObject({
      error: "invalid_target",
    });

    const impossible = await fetch(`${base}/api/http-target`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "devtools",
        authentication: { type: "oauth" },
      }),
    });
    expect(impossible.status).toBe(400);
    expect((await impossible.json()) as unknown).toMatchObject({
      error: "invalid_authentication",
    });

    const wrongMethod = await fetch(`${base}/api/http-target`, {
      method: "PATCH",
    });
    expect(wrongMethod.status).toBe(405);

    const foreignOrigin = await fetch(`${base}/api/http-target`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        origin: "http://attacker.example",
      },
      body: JSON.stringify({
        kind: "devtools",
        authentication: { type: "none" },
      }),
    });
    expect(foreignOrigin.status).toBe(403);

    // The selection is unchanged by every refusal above.
    const view = await fetch(`${base}/api/http-target`);
    expect((await view.json()) as unknown).toEqual({
      kind: "devtools",
      authentication: { type: "session-token" },
    });
  });

  it("names what is wrong with an unusable invocation request", async () => {
    const unknownAdapter = await invoke({
      adapter: "grpc",
      capabilityId: "fixture.report",
      arguments: {},
    });
    expect(unknownAdapter.status).toBe(400);
    expect((await unknownAdapter.json()) as unknown).toMatchObject({
      error: "unknown_adapter",
    });

    const unknownCapability = await invoke({
      adapter: "direct",
      capabilityId: "fixture.absent",
      arguments: {},
    });
    expect(unknownCapability.status).toBe(400);
    expect((await unknownCapability.json()) as unknown).toMatchObject({
      error: "unknown_capability",
    });

    const unknownPrincipal = await invoke({
      adapter: "direct",
      capabilityId: "fixture.report",
      arguments: {},
      principalKey: "p_absent",
    });
    expect(unknownPrincipal.status).toBe(400);
    expect((await unknownPrincipal.json()) as unknown).toMatchObject({
      error: "unknown_principal",
    });

    const wrongMethod = await fetch(`${base}/api/invoke`);
    expect(wrongMethod.status).toBe(405);

    const foreignOrigin = await fetch(`${base}/api/invoke`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://attacker.example",
      },
      body: JSON.stringify({
        adapter: "direct",
        capabilityId: "fixture.report",
        arguments: {},
      }),
    });
    expect(foreignOrigin.status).toBe(403);
  });
});

describe("startServe preflight", () => {
  it("refuses an engine that fails the doctor checks", async () => {
    const brokenEngine = {
      name: "broken",
      version: "0.1.0",
      invoke: async () => ({}),
      list: () => [{ id: "fixture.broken", description: "Broken." }],
      describe: () => {
        throw new Error("Fixture describe failed.");
      },
    };

    const result = await startServe({
      engine: brokenEngine,
      cwd: repositoryRoot,
      module: fixtureModule,
      composedCapabilitiesExport: false,
      uiRoot,
    });

    expect(result.kind).toBe("refused");
    if (result.kind === "refused") {
      expect(result.report.findings[0]?.code).toBe("DESCRIBE_FAILED");
    }
  });
});

describe("startServe trace capacity", () => {
  it("bounds the retained trace entries through traceCapacity", async () => {
    const result = await startOnAvailablePort((port) =>
      startServe({
        engine: buildEngine(),
        cwd: repositoryRoot,
        module: fixtureModule,
        composedCapabilitiesExport: false,
        port,
        uiRoot,
        traceCapacity: 3,
      }),
    );
    if (result.kind !== "started") throw new Error("serve was refused");
    const base = `http://127.0.0.1:${String(result.handles.devtoolsAddress.port)}`;
    try {
      const issued = await fetch(`${base}/api/principals`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ principal: { id: "capacity-tester" } }),
      });
      const { token } = (await issued.json()) as { token: string };

      for (let index = 0; index < 3; index += 1) {
        const response = await fetch(`${base}/mcp`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: index + 1,
            method: "tools/call",
            params: { name: "fixture_echo", arguments: { message: "hi" } },
          }),
        });
        await response.arrayBuffer();
      }

      // Each call appends an invocation and an exchange entry; the buffer
      // keeps only the newest three, which a fresh stream replays. Asking for
      // a fourth frame proves no more than three were retained.
      const replay = await readSse(`${base}/api/events`, 4, undefined, 1_500);
      expect(replay.match(/\ndata: /g) ?? []).toHaveLength(3);
    } finally {
      await result.handles.close();
    }
  });
});

describe("invokta-devtools serve", () => {
  beforeAll(() => {
    execFileSync(
      process.execPath,
      [
        "node_modules/typescript/bin/tsc",
        "-b",
        "packages/devtools",
        "--pretty",
        "false",
      ],
      { cwd: repositoryRoot, stdio: "pipe" },
    );
  });

  it("prints the ready line, serves, and shuts down cleanly on SIGTERM", async () => {
    const port = await freePort();
    const child = spawn(
      process.execPath,
      [
        join("packages/devtools/dist", "cli.js"),
        "serve",
        "packages/devtools/test/fixtures/valid-engine.js",
        "--port",
        String(port),
      ],
      { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    // ADR 0021 pins stdout to exactly this line.
    const readyLine = `Invokta devtools listening on http://127.0.0.1:${String(port)}/\n`;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`serve never became ready: ${stderr}`)),
        8000,
      );
      const poll = setInterval(() => {
        if (stdout.includes(readyLine)) {
          clearTimeout(timeout);
          clearInterval(poll);
          resolve();
        }
      }, 50);
    });

    const response = await fetch(`http://127.0.0.1:${String(port)}/api/engine`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { name: string }).name).toBe(
      "fixture-engine",
    );

    const exitCode = await new Promise<number | null>((resolve) => {
      child.once("exit", (code) => resolve(code));
      child.kill("SIGTERM");
    });

    expect(exitCode).toBe(0);
    // Stdout carries the ready line and nothing else; the startup context is
    // a diagnostic and belongs on stderr.
    expect(stdout).toBe(readyLine);
    expect(stderr).toContain(
      'engine: name="fixture-engine" version="0.1.0" capabilities=2',
    );
    expect(stderr).toContain("watch: off");
    expect(stderr).toContain("Ctrl+C to stop");
  }, 20_000);
});
