import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { packageManagerStrategies } from "../src/generate/lockfile.js";
import { planGeneratedFiles } from "../src/generate/plan.js";
import { parseProjectPackage } from "../src/generate/project-package.js";
import { parseDeployManifest } from "../src/manifest.js";

type Environment = Readonly<Record<string, string | undefined>>;

interface HealthcheckModule {
  readonly runHealthcheck: (environment: Environment) => Promise<number>;
}

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: string;
}

interface Stub {
  readonly port: number;
  readonly requests: readonly RecordedRequest[];
  readonly close: () => Promise<void>;
}

const project = parseProjectPackage(
  JSON.stringify({
    name: "support-engine",
    version: "1.4.2",
    scripts: { build: "tsc -b" },
  }),
);

const roots: string[] = [];
const servers: Server[] = [];

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function scriptFor(document: Readonly<Record<string, unknown>> = {}): string {
  const result = parseDeployManifest(
    JSON.stringify({
      schemaVersion: 1,
      entry: "dist/mcp-http.js",
      ...document,
    }),
  );
  if (!result.ok) throw new Error("the fixture manifest is invalid");
  const files = planGeneratedFiles({
    manifest: result.manifest,
    packageManager: packageManagerStrategies.npm,
    project,
  });
  const script = files.find((file) => file.path === "deploy/healthcheck.mjs");
  if (script === undefined)
    throw new Error("no health-check script was planned");
  return script.contents;
}

/** Emits the script and imports it, which also parses it as real ESM. */
async function loadScript(
  document: Readonly<Record<string, unknown>> = {},
): Promise<HealthcheckModule> {
  const root = mkdtempSync(join(tmpdir(), "ai-engine-healthcheck-"));
  roots.push(root);
  const file = join(root, "healthcheck.mjs");
  writeFileSync(file, scriptFor(document));
  return (await import(pathToFileURL(file).href)) as HealthcheckModule;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function startStub(
  respond: (
    request: RecordedRequest,
    reply: (
      status: number,
      headers: Readonly<Record<string, string>>,
      body: string,
    ) => void,
  ) => void,
): Promise<Stub> {
  const requests: RecordedRequest[] = [];
  const server = createServer((incoming, response) => {
    void (async () => {
      const recorded: RecordedRequest = {
        body: await readBody(incoming),
        headers: incoming.headers as Readonly<
          Record<string, string | undefined>
        >,
        method: incoming.method ?? "",
        url: incoming.url ?? "",
      };
      requests.push(recorded);
      respond(recorded, (status, headers, body) => {
        response.writeHead(status, headers);
        response.end(body);
      });
    })();
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
    port: address.port,
    requests,
  };
}

function jsonReply(
  status: number,
  body: unknown,
): (
  request: RecordedRequest,
  reply: (
    status: number,
    headers: Readonly<Record<string, string>>,
    body: string,
  ) => void,
) => void {
  return (_request, reply) => {
    reply(status, { "content-type": "application/json" }, JSON.stringify(body));
  };
}

function initializeResult(
  id: unknown = "ai-engine-deploy-healthcheck",
): unknown {
  return {
    id,
    jsonrpc: "2.0",
    result: {
      capabilities: {},
      protocolVersion: "2025-11-25",
      serverInfo: { name: "support-engine", version: "1.4.2" },
    },
  };
}

describe("generated health-check script", () => {
  it("imports Node built-ins only", () => {
    const script = scriptFor();
    const specifiers = [...script.matchAll(/from "([^"]+)"/gu)].map(
      (match) => match[1],
    );

    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier?.startsWith("node:")).toBe(true);
    }
    expect(script).not.toContain("@ai-engine/");
    expect(script).not.toContain("require(");
  });

  it("sends exactly one bounded initialize request to /mcp", async () => {
    const stub = await startStub(jsonReply(200, initializeResult()));
    const script = await loadScript();

    const exitCode = await script.runHealthcheck({
      AI_ENGINE_HTTP_PORT: String(stub.port),
    });

    expect(exitCode).toBe(0);
    expect(stub.requests).toHaveLength(1);
    const request = stub.requests[0] as RecordedRequest;
    expect(request.method).toBe("POST");
    expect(request.url).toBe("/mcp");
    expect(request.headers.accept).toBe("application/json, text/event-stream");
    expect(request.headers["content-type"]).toBe("application/json");
    expect(request.headers.authorization).toBeUndefined();
    expect(JSON.parse(request.body)).toEqual({
      id: "ai-engine-deploy-healthcheck",
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: expect.objectContaining({ name: expect.any(String) }),
        protocolVersion: "2025-11-25",
      },
    });
  });

  it("sends the first allowed host as the Host header", async () => {
    const stub = await startStub(jsonReply(200, initializeResult()));
    const script = await loadScript();

    const exitCode = await script.runHealthcheck({
      AI_ENGINE_HTTP_ALLOWED_HOSTS: " engine.example.com , backup.example.com ",
      AI_ENGINE_HTTP_PORT: String(stub.port),
    });

    expect(exitCode).toBe(0);
    expect((stub.requests[0] as RecordedRequest).headers.host).toBe(
      "engine.example.com",
    );
  });

  it("falls back to the loopback authority when no host is allowlisted", async () => {
    const stub = await startStub(jsonReply(200, initializeResult()));
    const script = await loadScript();

    await script.runHealthcheck({ AI_ENGINE_HTTP_PORT: String(stub.port) });

    expect((stub.requests[0] as RecordedRequest).headers.host).toBe(
      `127.0.0.1:${stub.port}`,
    );
  });

  it("prefers AI_ENGINE_HTTP_PORT over PORT and falls back to the manifest port", async () => {
    const stub = await startStub(jsonReply(200, initializeResult()));
    const script = await loadScript({ image: { port: stub.port } });

    await expect(
      script.runHealthcheck({
        AI_ENGINE_HTTP_PORT: String(stub.port),
        PORT: "1",
      }),
    ).resolves.toBe(0);
    await expect(
      script.runHealthcheck({ PORT: String(stub.port) }),
    ).resolves.toBe(0);
    await expect(script.runHealthcheck({})).resolves.toBe(0);
    expect(stub.requests).toHaveLength(3);
  });

  it("treats an unparsable port as unhealthy without a request", async () => {
    const stub = await startStub(jsonReply(200, initializeResult()));
    const script = await loadScript();
    vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await expect(
      script.runHealthcheck({ AI_ENGINE_HTTP_PORT: "not-a-port" }),
    ).resolves.toBe(1);
    expect(stub.requests).toHaveLength(0);
  });

  describe("alive expectation", () => {
    it("accepts a bearer challenge", async () => {
      const stub = await startStub((_request, reply) => {
        reply(401, { "www-authenticate": "Bearer" }, "");
      });
      const script = await loadScript();

      await expect(
        script.runHealthcheck({ AI_ENGINE_HTTP_PORT: String(stub.port) }),
      ).resolves.toBe(0);
      expect(stub.requests).toHaveLength(1);
    });

    it("accepts a challenge that carries resource metadata", async () => {
      const stub = await startStub((_request, reply) => {
        reply(
          401,
          { "www-authenticate": 'Bearer resource_metadata="https://e/x"' },
          "",
        );
      });
      const script = await loadScript();

      await expect(
        script.runHealthcheck({ AI_ENGINE_HTTP_PORT: String(stub.port) }),
      ).resolves.toBe(0);
    });

    it.each(["Basic realm=x", 'Basic realm="bearer-zone"', ""])(
      "rejects a 401 whose challenge does not offer Bearer: %s",
      async (challenge) => {
        const stub = await startStub((_request, reply) => {
          reply(401, { "www-authenticate": challenge }, "");
        });
        const script = await loadScript();
        const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

        await expect(
          script.runHealthcheck({ AI_ENGINE_HTTP_PORT: String(stub.port) }),
        ).resolves.toBe(1);
        expect(stderr).toHaveBeenCalled();
      },
    );

    it("accepts a valid initialize result", async () => {
      const stub = await startStub(jsonReply(200, initializeResult()));
      const script = await loadScript();

      await expect(
        script.runHealthcheck({ AI_ENGINE_HTTP_PORT: String(stub.port) }),
      ).resolves.toBe(0);
    });

    it("accepts an initialize result framed as a server-sent event", async () => {
      const stub = await startStub((_request, reply) => {
        reply(
          200,
          { "content-type": "text/event-stream" },
          `event: message\ndata: ${JSON.stringify(initializeResult())}\n\n`,
        );
      });
      const script = await loadScript();

      await expect(
        script.runHealthcheck({ AI_ENGINE_HTTP_PORT: String(stub.port) }),
      ).resolves.toBe(0);
    });

    it.each([
      [
        "a JSON-RPC error",
        {
          error: { code: -32_600, message: "no" },
          id: "ai-engine-deploy-healthcheck",
          jsonrpc: "2.0",
        },
      ],
      [
        "a missing protocol version",
        {
          id: "ai-engine-deploy-healthcheck",
          jsonrpc: "2.0",
          result: { serverInfo: {} },
        },
      ],
      [
        "an empty protocol version",
        {
          id: "ai-engine-deploy-healthcheck",
          jsonrpc: "2.0",
          result: { protocolVersion: "", serverInfo: {} },
        },
      ],
      [
        "a foreign JSON-RPC version",
        {
          id: "ai-engine-deploy-healthcheck",
          jsonrpc: "1.0",
          result: { protocolVersion: "2025-11-25", serverInfo: {} },
        },
      ],
      ["a non-object body", []],
    ])("rejects %s inside HTTP 200", async (_label, body) => {
      const stub = await startStub(jsonReply(200, body));
      const script = await loadScript();
      vi.spyOn(process.stderr, "write").mockReturnValue(true);

      await expect(
        script.runHealthcheck({ AI_ENGINE_HTTP_PORT: String(stub.port) }),
      ).resolves.toBe(1);
    });

    it("rejects an unparsable HTTP 200 body", async () => {
      const stub = await startStub((_request, reply) => {
        reply(200, { "content-type": "application/json" }, "not json");
      });
      const script = await loadScript();
      vi.spyOn(process.stderr, "write").mockReturnValue(true);

      await expect(
        script.runHealthcheck({ AI_ENGINE_HTTP_PORT: String(stub.port) }),
      ).resolves.toBe(1);
    });

    it.each([403, 404, 429, 500, 503])("rejects HTTP %i", async (status) => {
      const stub = await startStub((_request, reply) => {
        reply(status, {}, "");
      });
      const script = await loadScript();
      vi.spyOn(process.stderr, "write").mockReturnValue(true);

      await expect(
        script.runHealthcheck({ AI_ENGINE_HTTP_PORT: String(stub.port) }),
      ).resolves.toBe(1);
      expect(stub.requests).toHaveLength(1);
    });

    it("does not follow a redirect", async () => {
      const stub = await startStub((_request, reply) => {
        reply(302, { location: "http://127.0.0.1:1/mcp" }, "");
      });
      const script = await loadScript();
      vi.spyOn(process.stderr, "write").mockReturnValue(true);

      await expect(
        script.runHealthcheck({ AI_ENGINE_HTTP_PORT: String(stub.port) }),
      ).resolves.toBe(1);
      expect(stub.requests).toHaveLength(1);
    });

    it("reports a refused connection as unhealthy", async () => {
      const stub = await startStub(jsonReply(200, initializeResult()));
      const port = stub.port;
      await stub.close();
      const script = await loadScript();
      vi.spyOn(process.stderr, "write").mockReturnValue(true);

      await expect(
        script.runHealthcheck({ AI_ENGINE_HTTP_PORT: String(port) }),
      ).resolves.toBe(1);
    });

    it("abandons a silent endpoint at the deadline", {
      timeout: 15_000,
    }, async () => {
      const stub = await startStub(() => {
        // The stub accepts the request and never answers.
      });
      const script = await loadScript();
      vi.spyOn(process.stderr, "write").mockReturnValue(true);
      const started = Date.now();

      await expect(
        script.runHealthcheck({ AI_ENGINE_HTTP_PORT: String(stub.port) }),
      ).resolves.toBe(1);

      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(2_500);
      expect(elapsed).toBeLessThan(9_000);
      expect(stub.requests).toHaveLength(1);
    });
  });

  describe("ready expectation", () => {
    const ready = {
      healthcheck: { bearerEnv: "SUPPORT_API_TOKEN", expect: "ready" },
    } as const;
    const secret = "sentinel-token-that-must-never-be-printed";

    it("sends the declared bearer token and accepts an initialize result", async () => {
      const stub = await startStub(jsonReply(200, initializeResult()));
      const script = await loadScript(ready);

      await expect(
        script.runHealthcheck({
          AI_ENGINE_HTTP_PORT: String(stub.port),
          SUPPORT_API_TOKEN: secret,
        }),
      ).resolves.toBe(0);
      expect((stub.requests[0] as RecordedRequest).headers.authorization).toBe(
        `Bearer ${secret}`,
      );
    });

    it("rejects a bearer challenge", async () => {
      const stub = await startStub((_request, reply) => {
        reply(401, { "www-authenticate": "Bearer" }, "");
      });
      const script = await loadScript(ready);
      const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

      await expect(
        script.runHealthcheck({
          AI_ENGINE_HTTP_PORT: String(stub.port),
          SUPPORT_API_TOKEN: secret,
        }),
      ).resolves.toBe(1);
      for (const call of stderr.mock.calls) {
        expect(String(call[0])).not.toContain(secret);
      }
    });

    it("reports a missing bearer variable by name and sends no request", async () => {
      const stub = await startStub(jsonReply(200, initializeResult()));
      const script = await loadScript(ready);
      const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

      await expect(
        script.runHealthcheck({ AI_ENGINE_HTTP_PORT: String(stub.port) }),
      ).resolves.toBe(1);
      expect(stub.requests).toHaveLength(0);
      expect(String(stderr.mock.calls[0]?.[0])).toContain("SUPPORT_API_TOKEN");
    });

    it("never prints the token, even when the endpoint misbehaves", async () => {
      const stub = await startStub((_request, reply) => {
        reply(500, {}, secret);
      });
      const script = await loadScript(ready);
      const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

      await expect(
        script.runHealthcheck({
          AI_ENGINE_HTTP_PORT: String(stub.port),
          SUPPORT_API_TOKEN: secret,
        }),
      ).resolves.toBe(1);
      for (const call of stderr.mock.calls) {
        expect(String(call[0])).not.toContain(secret);
      }
    });

    it("keeps the token out of the generated file", () => {
      expect(scriptFor(ready)).toContain("SUPPORT_API_TOKEN");
      expect(scriptFor(ready)).not.toContain(secret);
    });
  });

  describe("as a container health check", () => {
    async function runAsScript(
      port: number,
      allowedHosts: string,
    ): Promise<number> {
      const root = mkdtempSync(join(tmpdir(), "ai-engine-healthcheck-run-"));
      roots.push(root);
      const file = join(root, "healthcheck.mjs");
      writeFileSync(file, scriptFor());
      const child = spawn(process.execPath, [file], {
        env: {
          AI_ENGINE_HTTP_ALLOWED_HOSTS: allowedHosts,
          AI_ENGINE_HTTP_PORT: String(port),
          PATH: process.env.PATH ?? "",
        },
        stdio: "ignore",
      });
      return new Promise<number>((resolve) => {
        child.on("exit", (code) => {
          resolve(code ?? -1);
        });
      });
    }

    it("exits 0 against an endpoint that validates the public Host", async () => {
      const stub = await startStub((request, reply) => {
        if (request.headers.host !== "engine.example.com") {
          reply(403, {}, "");
          return;
        }
        reply(
          200,
          { "content-type": "application/json" },
          JSON.stringify(initializeResult()),
        );
      });

      await expect(runAsScript(stub.port, "engine.example.com")).resolves.toBe(
        0,
      );
      expect(stub.requests).toHaveLength(1);
    });

    it("exits 1 when the endpoint rejects the Host it presents", async () => {
      const stub = await startStub((_request, reply) => {
        reply(403, {}, "");
      });

      await expect(runAsScript(stub.port, "other.example.com")).resolves.toBe(
        1,
      );
    });
  });
});
