import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";
import { startAttachedCliDevtoolsServer } from "../src/cli-attached-server.js";
import {
  type AttachedCliConnectionSummary,
  createAttachedCliSessionController,
} from "../src/cli-attached-session.js";
import * as doctor from "../src/doctor.js";
import * as loadEngine from "../src/load-engine.js";
import { startOnAvailablePort } from "./available-port.js";

const connection: AttachedCliConnectionSummary = {
  command: "node",
  capabilityCount: 1,
  validation: { status: "ok" },
};

const canary = "cli-server-canary-51d0e2aa";

interface RawHttpResponse {
  readonly status: number;
  readonly headers: ReadonlyMap<string, string>;
  readonly raw: string;
}

function parseRawHttpResponse(buffer: Buffer): RawHttpResponse {
  const raw = buffer.toString("utf8");
  const headerEnd = raw.indexOf("\r\n\r\n");
  const head = headerEnd === -1 ? raw : raw.slice(0, headerEnd);
  const lines = head.split("\r\n");
  const status = Number(lines[0]?.match(/^HTTP\/1\.1 (\d{3})/u)?.[1]);
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    headers.set(
      line.slice(0, separator).toLowerCase(),
      line.slice(separator + 1).trim(),
    );
  }
  return { status, headers, raw };
}

async function rawHttpRequest(
  server: Awaited<ReturnType<typeof startAttachedCliDevtoolsServer>>,
  chunks: readonly (string | Uint8Array)[],
): Promise<RawHttpResponse> {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const socket = createConnection(address.port, address.host);
    const responseChunks: Buffer[] = [];
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("Raw HTTP fixture timed out."));
    }, 1_000);
    const settle = (): void => {
      clearTimeout(timeout);
      resolve(parseRawHttpResponse(Buffer.concat(responseChunks)));
    };
    socket.once("connect", () => {
      for (const chunk of chunks) socket.write(chunk);
      socket.end();
    });
    socket.on("data", (chunk: Buffer) => responseChunks.push(chunk));
    socket.once("end", settle);
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function createController() {
  const owners = new Set<string>();
  const described = new Set<string>();
  return {
    state(owner: string) {
      return owners.has(owner)
        ? { state: "connected" as const, connection }
        : { state: "idle" as const };
    },
    connect: vi.fn(async (owner: string) => {
      owners.add(owner);
      return connection;
    }),
    refresh: vi.fn(async (owner: string) => {
      if (!owners.has(owner)) throw new Error("not connected");
      return connection;
    }),
    describe: vi.fn(async (owner: string, id: string) => {
      if (!owners.has(owner)) throw new Error("not connected");
      described.add(`${owner}:${id}`);
      return {
        id,
        description: "Echoes a value.",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
      };
    }),
    run: vi.fn(async (owner: string, id: string) => {
      if (!described.has(`${owner}:${id}`)) throw new Error("not described");
      return { ok: true };
    }),
    catalog(owner: string) {
      if (!owners.has(owner)) throw new Error("not connected");
      return [{ id: "fixture.echo", description: "Echoes a value." }];
    },
    description(owner: string) {
      if (!owners.has(owner)) return undefined;
      return {
        id: "fixture.echo",
        description: "Echoes a value.",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
      };
    },
    activity(owner: string) {
      if (!owners.has(owner)) throw new Error("not connected");
      return [
        {
          sequence: 1,
          operation: "list" as const,
          startedAt: "2026-08-15T00:00:00.000Z",
          durationMs: 4,
          outcome: "success" as const,
          exitCode: 0,
        },
      ];
    },
    disconnect: vi.fn(async (owner: string) => {
      owners.delete(owner);
    }),
    close: vi.fn(async () => {
      owners.clear();
    }),
  };
}

function cookiePair(response: Response): string {
  const value = response.headers.get("set-cookie");
  if (value === null) throw new Error("session cookie missing");
  return value.split(";", 1)[0] as string;
}

function mutationHeaders(
  base: string,
  cookie: string,
  csrf: string,
): Readonly<Record<string, string>> {
  return {
    "content-type": "application/json",
    cookie,
    origin: base,
    "x-invokta-csrf": csrf,
  };
}

const servers: Array<
  Awaited<ReturnType<typeof startAttachedCliDevtoolsServer>>
> = [];

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
  vi.restoreAllMocks();
});

describe("attached CLI devtools server", () => {
  it("starts an inert secured CLI shell and creates a browser session", async () => {
    const inspectSpy = vi.spyOn(doctor, "inspectEngine");
    const loadSpy = vi.spyOn(loadEngine, "loadEngineModule");
    const controller = createController();
    const server = await startOnAvailablePort((port) =>
      startAttachedCliDevtoolsServer({ port, controller }),
    );
    servers.push(server);
    const base = `http://127.0.0.1:${String(server.address().port)}`;

    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("access-control-allow-origin")).toBeNull();
    expect(page.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(page.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    const pageText = await page.text();
    expect(pageText).toContain(
      "<title>Invokta DevTools · CLI workbench</title>",
    );
    expect(pageText).toContain('href="/assets/attached.css"');
    expect(pageText).toContain('src="/assets/cli-app.js"');
    expect(pageText).toContain(
      "The Invokta DevTools interface requires JavaScript.",
    );

    const session = await fetch(`${base}/api/session`);
    expect(session.status).toBe(200);
    await expect(session.json()).resolves.toEqual({
      csrfToken: expect.any(String),
      state: "idle",
    });
    expect(controller.connect).not.toHaveBeenCalled();
    expect(inspectSpy).not.toHaveBeenCalled();
    expect(loadSpy).not.toHaveBeenCalled();
  });

  it("does not serve Doctor, MCP tools, or OAuth routes", async () => {
    const controller = createController();
    const server = await startOnAvailablePort((port) =>
      startAttachedCliDevtoolsServer({ port, controller }),
    );
    servers.push(server);
    const base = `http://127.0.0.1:${String(server.address().port)}`;
    const session = await fetch(`${base}/api/session`);
    const cookie = cookiePair(session);
    const csrf = ((await session.json()) as { csrfToken: string }).csrfToken;

    for (const path of [
      "/api/doctor",
      "/api/tools",
      "/api/tools/call",
      "/oauth/callback",
      "/oauth/result/success",
    ]) {
      const response = await fetch(`${base}${path}`, {
        headers: { cookie },
      });
      expect(response.status, path).toBe(404);
      expect(await response.text()).not.toMatch(/doctor|oauth|inspectEngine/i);
    }

    const posted = await fetch(`${base}/api/tools/call`, {
      method: "POST",
      headers: mutationHeaders(base, cookie, csrf),
      body: JSON.stringify({ name: "fixture.echo", arguments: {} }),
    });
    expect(posted.status).toBe(404);
  });

  it("connects, describes, and runs through CSRF-protected routes", async () => {
    const controller = createController();
    const server = await startOnAvailablePort((port) =>
      startAttachedCliDevtoolsServer({ port, controller }),
    );
    servers.push(server);
    const base = `http://127.0.0.1:${String(server.address().port)}`;
    const session = await fetch(`${base}/api/session`);
    const cookie = cookiePair(session);
    const csrf = ((await session.json()) as { csrfToken: string }).csrfToken;

    const connected = await fetch(`${base}/api/connection`, {
      method: "POST",
      headers: mutationHeaders(base, cookie, csrf),
      body: JSON.stringify({
        command: "node",
        args: ["cli.js"],
        env: { TOKEN: canary },
      }),
    });
    expect(connected.status).toBe(200);
    const connectedText = await connected.text();
    expect(connectedText).not.toContain(canary);
    const nextCsrf = connected.headers.get("x-invokta-csrf");
    expect(nextCsrf).toEqual(expect.any(String));

    const catalog = await fetch(`${base}/api/catalog`, { headers: { cookie } });
    expect(catalog.status).toBe(200);
    await expect(catalog.json()).resolves.toEqual({
      capabilities: [{ id: "fixture.echo", description: "Echoes a value." }],
    });

    const described = await fetch(`${base}/api/describe`, {
      method: "POST",
      headers: mutationHeaders(base, cookie, nextCsrf as string),
      body: JSON.stringify({ id: "fixture.echo" }),
    });
    expect(described.status).toBe(200);
    const describeCsrf = described.headers.get("x-invokta-csrf");

    const ran = await fetch(`${base}/api/run`, {
      method: "POST",
      headers: mutationHeaders(base, cookie, describeCsrf as string),
      body: JSON.stringify({ id: "fixture.echo", input: { value: "ok" } }),
    });
    expect(ran.status).toBe(200);
    await expect(ran.json()).resolves.toEqual({ result: { ok: true } });

    const activity = await fetch(`${base}/api/activity`, {
      headers: { cookie },
    });
    expect(activity.status).toBe(200);
    const activityText = await activity.text();
    expect(activityText).not.toContain(canary);
    expect(activityText).not.toContain("TOKEN");

    expect(controller.connect).toHaveBeenCalledOnce();
    expect(controller.describe).toHaveBeenCalledOnce();
    expect(controller.run).toHaveBeenCalledOnce();
  });

  it("rejects missing Origin and Host before spawning", async () => {
    const controller = createController();
    const server = await startOnAvailablePort((port) =>
      startAttachedCliDevtoolsServer({ port, controller }),
    );
    servers.push(server);
    const address = server.address();
    const authority = `${address.host}:${String(address.port)}`;
    const base = `http://${authority}`;
    const session = await fetch(`${base}/api/session`);
    const cookie = cookiePair(session);
    const csrf = ((await session.json()) as { csrfToken: string }).csrfToken;
    const body = JSON.stringify({ command: "node", env: { TOKEN: canary } });

    const missingOrigin = await rawHttpRequest(server, [
      [
        "POST /api/connection HTTP/1.1",
        `Host: ${authority}`,
        `Cookie: ${cookie}`,
        `X-Invokta-CSRF: ${csrf}`,
        "Content-Type: application/json",
        `Content-Length: ${Buffer.byteLength(body)}`,
        "Connection: close",
        "",
        body,
      ].join("\r\n"),
    ]);
    expect(missingOrigin.status).toBe(403);
    expect(missingOrigin.raw).not.toContain(canary);

    const foreignHost = await rawHttpRequest(server, [
      [
        "GET /api/session HTTP/1.1",
        "Host: attacker.example",
        "Connection: close",
        "",
        "",
      ].join("\r\n"),
    ]);
    expect(foreignHost.status).toBe(403);
    expect(controller.connect).not.toHaveBeenCalled();
  });

  it("advertises localhost and answers on every loopback authority", async () => {
    const controller = createController();
    const server = await startOnAvailablePort((port) =>
      startAttachedCliDevtoolsServer({ port, controller }),
    );
    servers.push(server);
    const address = server.address();
    expect(address.host).toBe("localhost");

    for (const authority of [
      `localhost:${String(address.port)}`,
      `127.0.0.1:${String(address.port)}`,
    ]) {
      const response = await fetch(`http://${authority}/api/session`);
      expect(response.status, authority).toBe(200);
      await response.arrayBuffer();
    }
  });

  it("walks to a free port when the requested one is taken", async () => {
    const first = await startOnAvailablePort((port) =>
      startAttachedCliDevtoolsServer({ port, controller: createController() }),
    );
    servers.push(first);
    const taken = first.address().port;

    const inUse: number[] = [];
    const second = await startAttachedCliDevtoolsServer({
      port: taken,
      controller: createController(),
      onPortInUse: (port) => {
        inUse.push(port);
      },
    });
    servers.push(second);

    expect(second.address().port).toBeGreaterThan(taken);
    expect(inUse).toStrictEqual([taken]);
  });

  it("does not load an engine module or adapter-runner on startup", async () => {
    const inspectSpy = vi.spyOn(doctor, "inspectEngine");
    const loadSpy = vi.spyOn(loadEngine, "loadEngineModule");
    const spawn = vi.fn();
    const controller = createAttachedCliSessionController({ spawn });
    const server = await startOnAvailablePort((port) =>
      startAttachedCliDevtoolsServer({ port, controller }),
    );
    servers.push(server);
    const base = `http://127.0.0.1:${String(server.address().port)}`;
    await fetch(`${base}/`);
    await fetch(`${base}/api/session`);
    expect(inspectSpy).not.toHaveBeenCalled();
    expect(loadSpy).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    const srcRoot = fileURLToPath(new URL("../src/", import.meta.url));
    const serverSource = readFileSync(
      `${srcRoot}cli-attached-server.ts`,
      "utf8",
    );
    const sessionSource = readFileSync(
      `${srcRoot}cli-attached-session.ts`,
      "utf8",
    );
    expect(serverSource).not.toContain("adapter-runner");
    expect(serverSource).not.toContain("load-engine");
    expect(serverSource).not.toContain("inspectEngine");
    expect(sessionSource).not.toContain("adapter-runner");
    expect(sessionSource).not.toContain("@invokta/cli");
  });
});
