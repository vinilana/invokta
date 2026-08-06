import { createConnection } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AttachedConnectionSummary,
  AttachedServerController,
} from "../src/attached-server.js";
import { startAttachedDevtoolsServer } from "../src/attached-server.js";
import { createAttachedSessionController } from "../src/attached-session.js";
import { startOnAvailablePort } from "./available-port.js";

const connection: AttachedConnectionSummary = {
  transport: "http",
  server: {
    name: "fixture-mcp",
    version: "1.0.0",
    protocolVersion: "2025-11-25",
  },
  validation: { status: "ok" },
  pageCount: 1,
  toolCount: 1,
};

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
  server: Awaited<ReturnType<typeof startAttachedDevtoolsServer>>,
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

async function rawHttpResponseBeforeBodyEnds(
  server: Awaited<ReturnType<typeof startAttachedDevtoolsServer>>,
  requestHeadAndPrefix: string,
): Promise<{ readonly response: RawHttpResponse; readonly closed: boolean }> {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const socket = createConnection(address.port, address.host);
    const responseChunks: Buffer[] = [];
    let settled = false;
    const finish = (closed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve({
        response: parseRawHttpResponse(Buffer.concat(responseChunks)),
        closed,
      });
    };
    const timeout = setTimeout(() => finish(false), 1_000);
    socket.once("connect", () => socket.write(requestHeadAndPrefix));
    socket.on("data", (chunk: Buffer) => responseChunks.push(chunk));
    socket.once("end", () => finish(true));
    socket.once("close", () => finish(true));
    socket.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function chunkedMutationRequest(
  authority: string,
  origin: string,
  cookie: string,
  csrf: string,
  bodyChunks: readonly Uint8Array[],
): readonly (string | Uint8Array)[] {
  return [
    [
      "POST /api/connection HTTP/1.1",
      `Host: ${authority}`,
      `Origin: ${origin}`,
      `Cookie: ${cookie}`,
      `X-Invokta-CSRF: ${csrf}`,
      "Content-Type: application/json",
      "Transfer-Encoding: chunked",
      "Connection: close",
      "",
      "",
    ].join("\r\n"),
    ...bodyChunks.flatMap((chunk) => [
      `${chunk.byteLength.toString(16)}\r\n`,
      chunk,
      "\r\n",
    ]),
    "0\r\n\r\n",
  ];
}

function createController(): AttachedServerController & {
  readonly connect: ReturnType<typeof vi.fn>;
  readonly beginOAuth: ReturnType<typeof vi.fn>;
  readonly completeOAuth: ReturnType<typeof vi.fn>;
  readonly rejectOAuth: ReturnType<typeof vi.fn>;
  readonly disconnect: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
} {
  const owners = new Set<string>();
  let pendingOAuth:
    | { readonly owner: string; readonly state: string }
    | undefined;
  return {
    state(owner) {
      if (pendingOAuth !== undefined) {
        return pendingOAuth.owner === owner
          ? { state: "authorizing", transport: "http" }
          : { state: "busy" };
      }
      return owners.has(owner)
        ? { state: "connected", connection }
        : { state: "idle" };
    },
    connect: vi.fn(async (owner: string) => {
      owners.add(owner);
      return connection;
    }),
    beginOAuth: vi.fn(
      async (
        owner: string,
        _target: unknown,
        options: { readonly state: string },
      ) => {
        pendingOAuth = { owner, state: options.state };
        return {
          authorizationUrl: `https://identity.example.test/authorize?state=${options.state}`,
        };
      },
    ),
    completeOAuth: vi.fn(async (state: string) => {
      if (pendingOAuth?.state !== state) throw new Error("wrong state");
      owners.add(pendingOAuth.owner);
      pendingOAuth = undefined;
      return connection;
    }),
    rejectOAuth: vi.fn(async (state: string) => {
      if (pendingOAuth?.state !== state) throw new Error("wrong state");
      pendingOAuth = undefined;
    }),
    tools(owner) {
      if (!owners.has(owner)) throw new Error("not connected");
      return [
        {
          name: "fixture.echo",
          description: "Echoes a value.",
          inputSchema: { type: "object" },
        },
      ];
    },
    call: vi.fn(async (owner: string) => {
      if (!owners.has(owner)) throw new Error("not connected");
      return { response: { content: [{ type: "text", text: "ok" }] } };
    }),
    activity(owner) {
      if (!owners.has(owner)) throw new Error("not connected");
      return [
        {
          sequence: 1,
          operation: "initialize",
          startedAt: "2026-08-06T00:00:00.000Z",
          durationMs: 4,
          outcome: "success",
        },
      ];
    },
    disconnect: vi.fn(async (owner: string) => {
      owners.delete(owner);
      if (pendingOAuth?.owner === owner) pendingOAuth = undefined;
    }),
    close: vi.fn(async () => {
      owners.clear();
      pendingOAuth = undefined;
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

const servers: Array<Awaited<ReturnType<typeof startAttachedDevtoolsServer>>> =
  [];

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
});

describe("attached devtools server", () => {
  it("starts an inert secured shell and creates an isolated browser session", async () => {
    const controller = createController();
    const server = await startOnAvailablePort((port) =>
      startAttachedDevtoolsServer({ port, controller }),
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
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    const pageText = await page.text();
    expect(pageText).toContain('href="/assets/attached.css"');
    expect(pageText).toContain(
      '<link rel="icon" type="image/svg+xml" href="/assets/favicon.svg">',
    );
    expect(pageText).toContain('src="/assets/attached-app.js"');

    const favicon = await fetch(`${base}/assets/favicon.svg`);
    expect(favicon.status).toBe(200);
    expect(favicon.headers.get("content-type")).toBe("image/svg+xml");
    expect(favicon.headers.get("cache-control")).toBe("no-store");
    expect(favicon.headers.get("x-content-type-options")).toBe("nosniff");
    expect(favicon.headers.get("content-security-policy")).toBe(
      page.headers.get("content-security-policy"),
    );
    expect(await favicon.text()).toMatch(
      /^<svg[^>]+viewBox="0 0 32 32"[\s\S]+stroke="#3D50F5"[\s\S]+<\/svg>$/u,
    );

    const session = await fetch(`${base}/api/session`);
    expect(session.status).toBe(200);
    const body = (await session.json()) as {
      readonly csrfToken: string;
      readonly state: string;
    };
    expect(body).toEqual({ csrfToken: expect.any(String), state: "idle" });
    expect(body.csrfToken.length).toBeGreaterThanOrEqual(32);
    expect(session.headers.get("set-cookie")).toContain("HttpOnly");
    expect(session.headers.get("set-cookie")).toContain("SameSite=Strict");
    expect(session.headers.get("set-cookie")).not.toContain("Max-Age");
    expect(controller.connect).not.toHaveBeenCalled();
  });

  it("rejects missing, duplicate, and foreign raw Host headers", async () => {
    const controller = createController();
    const server = await startOnAvailablePort((port) =>
      startAttachedDevtoolsServer({ port, controller }),
    );
    servers.push(server);
    const address = server.address();
    const authority = `${address.host}:${String(address.port)}`;

    const requests = [
      ["GET /api/session HTTP/1.0", "Connection: close", "", ""].join("\r\n"),
      [
        "GET /api/session HTTP/1.1",
        `Host: ${authority}`,
        "Host: attacker.example",
        "Connection: close",
        "",
        "",
      ].join("\r\n"),
      [
        "GET /api/session HTTP/1.1",
        "Host: attacker.example",
        "Connection: close",
        "",
        "",
      ].join("\r\n"),
    ];

    for (const request of requests) {
      const response = await rawHttpRequest(server, [request]);
      expect(response.status).toBe(403);
      expect(response.headers.get("connection")).toBe("close");
    }
    expect(controller.connect).not.toHaveBeenCalled();
  });

  it("rejects missing, duplicate, and foreign raw Origin headers before parsing", async () => {
    const controller = createController();
    const server = await startOnAvailablePort((port) =>
      startAttachedDevtoolsServer({ port, controller }),
    );
    servers.push(server);
    const address = server.address();
    const authority = `${address.host}:${String(address.port)}`;
    const base = `http://${authority}`;
    const session = await fetch(`${base}/api/session`);
    const cookie = cookiePair(session);
    const csrf = ((await session.json()) as { csrfToken: string }).csrfToken;
    const body = "{}";
    const common = [
      "POST /api/connection HTTP/1.1",
      `Host: ${authority}`,
      `Cookie: ${cookie}`,
      `X-Invokta-CSRF: ${csrf}`,
      "Content-Type: application/json",
      `Content-Length: ${Buffer.byteLength(body)}`,
      "Connection: close",
    ];
    const origins: readonly string[][] = [
      [],
      ["Origin: https://attacker.example"],
      [`Origin: ${base}`, `Origin: ${base}`],
    ];

    for (const originHeaders of origins) {
      const request = [...common, ...originHeaders, "", body].join("\r\n");
      const response = await rawHttpRequest(server, [request]);
      expect(response.status).toBe(403);
      expect(response.headers.get("connection")).toBe("close");
    }
    expect(controller.connect).not.toHaveBeenCalled();
  });

  it("rejects duplicate raw CSRF and Content-Type headers", async () => {
    const controller = createController();
    const server = await startOnAvailablePort((port) =>
      startAttachedDevtoolsServer({ port, controller }),
    );
    servers.push(server);
    const address = server.address();
    const authority = `${address.host}:${String(address.port)}`;
    const base = `http://${authority}`;
    const session = await fetch(`${base}/api/session`);
    const cookie = cookiePair(session);
    const csrf = ((await session.json()) as { csrfToken: string }).csrfToken;
    const body = "{}";

    const duplicateCsrf = await rawHttpRequest(server, [
      [
        "POST /api/connection HTTP/1.1",
        `Host: ${authority}`,
        `Origin: ${base}`,
        `Cookie: ${cookie}`,
        `X-Invokta-CSRF: ${csrf}`,
        `X-Invokta-CSRF: ${csrf}`,
        "Content-Type: application/json",
        `Content-Length: ${Buffer.byteLength(body)}`,
        "Connection: close",
        "",
        body,
      ].join("\r\n"),
    ]);
    expect(duplicateCsrf.status).toBe(403);

    const duplicateContentType = await rawHttpRequest(server, [
      [
        "POST /api/connection HTTP/1.1",
        `Host: ${authority}`,
        `Origin: ${base}`,
        `Cookie: ${cookie}`,
        `X-Invokta-CSRF: ${csrf}`,
        "Content-Type: application/json",
        "Content-Type: application/json",
        `Content-Length: ${Buffer.byteLength(body)}`,
        "Connection: close",
        "",
        body,
      ].join("\r\n"),
    ]);
    expect(duplicateContentType.status).toBe(400);
    expect(controller.connect).not.toHaveBeenCalled();
  });

  it("rejects malformed UTF-8 and accepts a multibyte scalar split across chunks", async () => {
    const controller = createController();
    const server = await startOnAvailablePort((port) =>
      startAttachedDevtoolsServer({ port, controller }),
    );
    servers.push(server);
    const address = server.address();
    const authority = `${address.host}:${String(address.port)}`;
    const base = `http://${authority}`;
    const session = await fetch(`${base}/api/session`);
    const cookie = cookiePair(session);
    const csrf = ((await session.json()) as { csrfToken: string }).csrfToken;
    const malformed = Buffer.concat([
      Buffer.from('{"transport":"stdio","command":"', "utf8"),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('"}', "utf8"),
    ]);

    const malformedResponse = await rawHttpRequest(
      server,
      chunkedMutationRequest(authority, base, cookie, csrf, [malformed]),
    );
    expect(malformedResponse.status).toBe(400);
    expect(controller.connect).not.toHaveBeenCalled();

    const validBody = Buffer.from(
      '{"transport":"stdio","command":"serve-€"}',
      "utf8",
    );
    const scalarStart = validBody.indexOf(Buffer.from("€", "utf8"));
    const validResponse = await rawHttpRequest(
      server,
      chunkedMutationRequest(authority, base, cookie, csrf, [
        validBody.subarray(0, scalarStart + 1),
        validBody.subarray(scalarStart + 1, scalarStart + 2),
        validBody.subarray(scalarStart + 2),
      ]),
    );
    expect(validResponse.status).toBe(200);
    expect(controller.connect).toHaveBeenCalledTimes(1);
    expect(controller.connect.mock.calls[0]?.[1]).toEqual({
      transport: "stdio",
      command: "serve-€",
    });
  });

  it("emits the exact CSP and no CORS headers on raw shell and error responses", async () => {
    const controller = createController();
    const server = await startOnAvailablePort((port) =>
      startAttachedDevtoolsServer({ port, controller }),
    );
    servers.push(server);
    const address = server.address();
    const authority = `${address.host}:${String(address.port)}`;
    const expectedCsp =
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";
    const requests = [
      [
        "GET / HTTP/1.1",
        `Host: ${authority}`,
        "Connection: close",
        "",
        "",
      ].join("\r\n"),
      [
        "GET /api/session HTTP/1.1",
        "Host: attacker.example",
        "Connection: close",
        "",
        "",
      ].join("\r\n"),
    ];

    for (const request of requests) {
      const response = await rawHttpRequest(server, [request]);
      expect(response.headers.get("content-security-policy")).toBe(expectedCsp);
      expect(
        [...response.headers.keys()].some((name) =>
          name.startsWith("access-control-"),
        ),
      ).toBe(false);
    }
  });

  it("rejects a declared oversized body before waiting for it and closes the connection", async () => {
    const controller = createController();
    const server = await startOnAvailablePort((port) =>
      startAttachedDevtoolsServer({ port, controller }),
    );
    servers.push(server);
    const address = server.address();
    const authority = `${address.host}:${String(address.port)}`;
    const base = `http://${authority}`;
    const session = await fetch(`${base}/api/session`);
    const cookie = cookiePair(session);
    const csrf = ((await session.json()) as { csrfToken: string }).csrfToken;

    const outcome = await rawHttpResponseBeforeBodyEnds(
      server,
      [
        "POST /api/connection HTTP/1.1",
        `Host: ${authority}`,
        `Origin: ${base}`,
        `Cookie: ${cookie}`,
        `X-Invokta-CSRF: ${csrf}`,
        "Content-Type: application/json",
        `Content-Length: ${1024 * 1024 + 1}`,
        "",
        "{",
      ].join("\r\n"),
    );

    expect(outcome.response.status).toBe(413);
    expect(outcome.response.headers.get("connection")).toBe("close");
    expect(outcome.closed).toBe(true);
    expect(controller.connect).not.toHaveBeenCalled();
  });

  it("rejects a streamed oversized body before its terminal chunk and closes the connection", async () => {
    const controller = createController();
    const server = await startOnAvailablePort((port) =>
      startAttachedDevtoolsServer({ port, controller }),
    );
    servers.push(server);
    const address = server.address();
    const authority = `${address.host}:${String(address.port)}`;
    const base = `http://${authority}`;
    const session = await fetch(`${base}/api/session`);
    const cookie = cookiePair(session);
    const csrf = ((await session.json()) as { csrfToken: string }).csrfToken;
    const oversizedBytes = 1024 * 1024 + 1;

    const outcome = await rawHttpResponseBeforeBodyEnds(
      server,
      [
        "POST /api/connection HTTP/1.1",
        `Host: ${authority}`,
        `Origin: ${base}`,
        `Cookie: ${cookie}`,
        `X-Invokta-CSRF: ${csrf}`,
        "Content-Type: application/json",
        "Transfer-Encoding: chunked",
        "",
        oversizedBytes.toString(16),
        "x".repeat(oversizedBytes),
        "",
      ].join("\r\n"),
    );

    expect(outcome.response.status).toBe(413);
    expect(outcome.response.headers.get("connection")).toBe("close");
    expect(outcome.closed).toBe(true);
    expect(controller.connect).not.toHaveBeenCalled();
  });

  it("requires the owning cookie, exact origin, and rotating CSRF token", async () => {
    const controller = createController();
    const server = await startOnAvailablePort((port) =>
      startAttachedDevtoolsServer({ port, controller }),
    );
    servers.push(server);
    const base = `http://127.0.0.1:${String(server.address().port)}`;
    const session = await fetch(`${base}/api/session`);
    const cookie = cookiePair(session);
    const { csrfToken } = (await session.json()) as {
      readonly csrfToken: string;
    };
    const target = {
      transport: "http",
      url: "https://mcp.example.test/rpc",
      authentication: { type: "bearer", token: "canary-secret" },
    };

    for (const headers of [
      { "content-type": "application/json" },
      {
        "content-type": "application/json",
        cookie,
        origin: "https://attacker.example",
        "x-invokta-csrf": csrfToken,
      },
      {
        "content-type": "application/json",
        cookie,
        origin: base,
      },
    ]) {
      const rejected = await fetch(`${base}/api/connection`, {
        method: "POST",
        headers,
        body: JSON.stringify(target),
      });
      expect(rejected.status).toBe(403);
    }
    expect(controller.connect).not.toHaveBeenCalled();

    const connected = await fetch(`${base}/api/connection`, {
      method: "POST",
      headers: mutationHeaders(base, cookie, csrfToken),
      body: JSON.stringify(target),
    });
    expect(connected.status).toBe(200);
    const responseText = await connected.text();
    expect(responseText).not.toContain("canary-secret");
    expect(responseText).not.toContain("mcp.example.test");
    expect(responseText).not.toContain("authentication");
    expect(JSON.parse(responseText)).toEqual({
      state: "connected",
      connection,
    });
    const nextCsrf = connected.headers.get("x-invokta-csrf");
    expect(nextCsrf).toEqual(expect.any(String));
    expect(nextCsrf).not.toBe(csrfToken);
    expect(controller.connect).toHaveBeenCalledTimes(1);
    expect(controller.connect.mock.calls[0]?.[1]).toEqual(target);

    const stale = await fetch(`${base}/api/connection`, {
      method: "DELETE",
      headers: {
        cookie,
        origin: base,
        "x-invokta-csrf": csrfToken,
      },
    });
    expect(stale.status).toBe(403);
    expect(controller.disconnect).not.toHaveBeenCalled();

    const disconnected = await fetch(`${base}/api/connection`, {
      method: "DELETE",
      headers: {
        cookie,
        origin: base,
        "x-invokta-csrf": nextCsrf as string,
      },
    });
    expect(disconnected.status).toBe(200);
    expect(await disconnected.json()).toEqual({ state: "idle" });
    expect(disconnected.headers.get("x-invokta-csrf")).not.toBe(nextCsrf);
    expect(controller.disconnect).toHaveBeenCalledTimes(1);
  });

  it("exposes the retained activity in the idle session state", async () => {
    const controller = createAttachedSessionController({
      connectClient: vi.fn(async () => ({
        server: {
          name: "fixture-mcp",
          version: "1.0.0",
          protocolVersion: "2025-11-25",
          capabilities: {},
        },
        listTools: vi.fn(async () => ({ tools: [] })),
        callTool: vi.fn(async () => ({ response: { content: [] } })),
        close: vi.fn(async () => undefined),
      })) as never,
    });
    const server = await startOnAvailablePort((port) =>
      startAttachedDevtoolsServer({ port, controller }),
    );
    servers.push(server);
    const base = `http://127.0.0.1:${String(server.address().port)}`;
    const session = await fetch(`${base}/api/session`);
    const cookie = cookiePair(session);
    const csrf = ((await session.json()) as { csrfToken: string }).csrfToken;
    const target = {
      transport: "http",
      url: "https://mcp.example.test/mcp",
      authentication: { type: "none" },
    };

    const connected = await fetch(`${base}/api/connection`, {
      method: "POST",
      headers: mutationHeaders(base, cookie, csrf),
      body: JSON.stringify(target),
    });
    expect(connected.status).toBe(200);
    const nextCsrf = connected.headers.get("x-invokta-csrf") as string;

    const disconnected = await fetch(`${base}/api/connection`, {
      method: "DELETE",
      headers: { cookie, origin: base, "x-invokta-csrf": nextCsrf },
    });
    expect(disconnected.status).toBe(200);

    const polled = await fetch(`${base}/api/session`, {
      headers: { cookie },
    });
    expect(polled.status).toBe(200);
    const idle = (await polled.json()) as {
      readonly state: string;
      readonly activity?: ReadonlyArray<{ readonly operation: string }>;
    };
    expect(idle.state).toBe("idle");
    expect(idle.activity?.map((record) => record.operation)).toEqual([
      "initialize",
      "tools/list",
      "disconnect",
    ]);

    const activity = await fetch(`${base}/api/activity`, {
      headers: { cookie },
    });
    expect(activity.status).toBe(200);
    const activityBody = (await activity.json()) as {
      readonly records: readonly unknown[];
    };
    expect(activityBody.records).toHaveLength(3);
  });

  it("starts OAuth and completes its one-time callback without exposing secrets", async () => {
    const controller = createController();
    const server = await startOnAvailablePort((port) =>
      startAttachedDevtoolsServer({ port, controller }),
    );
    servers.push(server);
    const base = `http://127.0.0.1:${String(server.address().port)}`;
    const session = await fetch(`${base}/api/session`);
    const cookie = cookiePair(session);
    const csrf = ((await session.json()) as { csrfToken: string }).csrfToken;
    const target = {
      transport: "http",
      url: "https://mcp.example.test/rpc",
      authentication: { type: "oauth" },
    };

    const started = await fetch(`${base}/api/connection`, {
      method: "POST",
      headers: mutationHeaders(base, cookie, csrf),
      body: JSON.stringify(target),
    });
    expect(started.status).toBe(202);
    const startedBody = (await started.json()) as {
      readonly state: string;
      readonly authorizationUrl: string;
    };
    expect(startedBody.state).toBe("authorizing");
    expect(startedBody.authorizationUrl).toMatch(
      /^https:\/\/identity\.example\.test\/authorize\?state=[A-Za-z0-9_-]{43}$/u,
    );
    expect(controller.connect).not.toHaveBeenCalled();
    expect(controller.beginOAuth).toHaveBeenCalledWith(
      expect.any(String),
      target,
      {
        redirectUrl: `${base}/oauth/callback`,
        state: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      },
    );
    const oauthState = new URL(startedBody.authorizationUrl).searchParams.get(
      "state",
    ) as string;
    const authorizationCode = "x".repeat(4_096);
    const callbackPrefix = `/oauth/callback?state=${oauthState}&code=${authorizationCode}&padding=`;
    const callbackTarget = `${callbackPrefix}${"p".repeat(
      8_192 - Buffer.byteLength(callbackPrefix),
    )}`;
    expect(Buffer.byteLength(callbackTarget)).toBe(8_192);
    const callbackResponse = await rawHttpRequest(server, [
      [
        `GET ${callbackTarget} HTTP/1.1`,
        `Host: 127.0.0.1:${String(server.address().port)}`,
        "Connection: close",
        "",
        "",
      ].join("\r\n"),
    ]);
    expect(callbackResponse.status).toBe(303);
    expect(callbackResponse.headers.get("location")).toBe(
      "/oauth/result/success",
    );

    const callback = await fetch(`${base}/oauth/result/success`);
    expect(callback.status).toBe(200);
    expect(callback.url).toBe(`${base}/oauth/result/success`);
    expect(callback.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(callback.headers.get("access-control-allow-origin")).toBeNull();
    const callbackText = await callback.text();
    expect(callbackText).toContain("Authorization complete");
    expect(callbackText).toContain(
      '<link rel="icon" type="image/svg+xml" href="/assets/favicon.svg">',
    );
    expect(callbackText).not.toContain(authorizationCode);
    expect(callbackText).not.toContain(oauthState);
    expect(controller.completeOAuth).toHaveBeenCalledWith(
      oauthState,
      authorizationCode,
    );

    const resumed = await fetch(`${base}/api/session`, {
      headers: { cookie },
    });
    expect(await resumed.json()).toMatchObject({ state: "connected" });
  });

  it("consumes OAuth provider rejection and rejects ambiguous callbacks", async () => {
    const controller = createController();
    const server = await startOnAvailablePort((port) =>
      startAttachedDevtoolsServer({ port, controller }),
    );
    servers.push(server);
    const base = `http://127.0.0.1:${String(server.address().port)}`;
    const session = await fetch(`${base}/api/session`);
    const cookie = cookiePair(session);
    const csrf = ((await session.json()) as { csrfToken: string }).csrfToken;
    const started = await fetch(`${base}/api/connection`, {
      method: "POST",
      headers: mutationHeaders(base, cookie, csrf),
      body: JSON.stringify({
        transport: "http",
        url: "https://mcp.example.test/rpc",
        authentication: { type: "oauth" },
      }),
    });
    const authorizationUrl = (
      (await started.json()) as { readonly authorizationUrl: string }
    ).authorizationUrl;
    const state = new URL(authorizationUrl).searchParams.get("state") as string;
    const providerError = "access_denied_canary";

    const oversizedTarget = await rawHttpRequest(server, [
      [
        `GET /oauth/callback?state=${state}&code=${"x".repeat(8_192)} HTTP/1.1`,
        `Host: 127.0.0.1:${String(server.address().port)}`,
        "Connection: close",
        "",
        "",
      ].join("\r\n"),
    ]);
    expect(oversizedTarget.status).toBe(303);
    expect(oversizedTarget.headers.get("location")).toBe(
      "/oauth/result/invalid",
    );

    for (const callbackTarget of [
      `/x/../oauth/callback?state=${state}&code=alias-code`,
      `${base}/oauth/callback?state=${state}&code=absolute-code`,
      `/oauth/callback?state=${state}&code=fragment-code#fragment`,
    ]) {
      const aliased = await rawHttpRequest(server, [
        [
          `GET ${callbackTarget} HTTP/1.1`,
          `Host: 127.0.0.1:${String(server.address().port)}`,
          "Connection: close",
          "",
          "",
        ].join("\r\n"),
      ]);
      expect(aliased.status).toBe(303);
      expect(aliased.headers.get("location")).toBe("/oauth/result/invalid");
    }
    expect(controller.completeOAuth).not.toHaveBeenCalled();
    expect(controller.rejectOAuth).not.toHaveBeenCalled();

    const queriedApi = await fetch(`${base}/api/session?unexpected=true`);
    expect(queriedApi.status).toBe(400);
    await expect(queriedApi.json()).resolves.toMatchObject({
      code: "INVALID_REQUEST",
    });

    const normalizedApi = await rawHttpRequest(server, [
      [
        "GET /api/x/../session HTTP/1.1",
        `Host: 127.0.0.1:${String(server.address().port)}`,
        "Connection: close",
        "",
        "",
      ].join("\r\n"),
    ]);
    expect(normalizedApi.status).toBe(400);

    const foreignMutation = await fetch(
      `${base}/oauth/callback?state=${state}&error=access_denied`,
      { method: "POST", headers: { origin: "https://attacker.example" } },
    );
    expect(foreignMutation.status).toBe(403);

    const ambiguous = await fetch(
      `${base}/oauth/callback?state=${state}&state=${state}&code=code`,
    );
    expect(ambiguous.status).toBe(400);
    expect(ambiguous.url).toBe(`${base}/oauth/result/invalid`);
    expect(controller.completeOAuth).not.toHaveBeenCalled();
    expect(controller.rejectOAuth).not.toHaveBeenCalled();

    const rejected = await fetch(
      `${base}/oauth/callback?state=${state}&error=${providerError}`,
    );
    expect(rejected.status).toBe(400);
    expect(rejected.url).toBe(`${base}/oauth/result/rejected`);
    const rejectedText = await rejected.text();
    expect(rejectedText).toContain("Authorization was not completed");
    expect(rejectedText).not.toContain(providerError);
    expect(rejectedText).not.toContain(state);
    expect(controller.rejectOAuth).toHaveBeenCalledWith(state);

    const replay = await fetch(
      `${base}/oauth/callback?state=${state}&code=replayed-code`,
    );
    expect(replay.status).toBe(502);
    expect(replay.url).toBe(`${base}/oauth/result/error`);
    expect(controller.completeOAuth).toHaveBeenCalledOnce();

    const nextCsrf = started.headers.get("x-invokta-csrf");
    const restarted = await fetch(`${base}/api/connection`, {
      method: "POST",
      headers: mutationHeaders(base, cookie, nextCsrf as string),
      body: JSON.stringify({
        transport: "http",
        url: "https://mcp.example.test/rpc",
        authentication: { type: "oauth" },
      }),
    });
    const restartedUrl = (
      (await restarted.json()) as { readonly authorizationUrl: string }
    ).authorizationUrl;
    const restartedState = new URL(restartedUrl).searchParams.get(
      "state",
    ) as string;
    const oversizedCode = await fetch(
      `${base}/oauth/callback?state=${restartedState}&code=${"x".repeat(4_097)}`,
    );
    expect(oversizedCode.status).toBe(400);
    expect(oversizedCode.url).toBe(`${base}/oauth/result/invalid`);
    expect(controller.rejectOAuth).toHaveBeenCalledWith(restartedState);

    const malformedReplay = await fetch(
      `${base}/oauth/callback?state=${restartedState}&code=late-code`,
    );
    expect(malformedReplay.status).toBe(502);
  });

  it("keeps connected data private to the browser session that owns it", async () => {
    const controller = createController();
    const server = await startOnAvailablePort((port) =>
      startAttachedDevtoolsServer({ port, controller }),
    );
    servers.push(server);
    const base = `http://127.0.0.1:${String(server.address().port)}`;

    const ownerSession = await fetch(`${base}/api/session`);
    const ownerCookie = cookiePair(ownerSession);
    const ownerCsrf = ((await ownerSession.json()) as { csrfToken: string })
      .csrfToken;
    await fetch(`${base}/api/connection`, {
      method: "POST",
      headers: mutationHeaders(base, ownerCookie, ownerCsrf),
      body: JSON.stringify({
        transport: "stdio",
        command: "fixture-mcp",
        env: { API_TOKEN: "canary-secret" },
      }),
    });

    const tools = await fetch(`${base}/api/tools`, {
      headers: { cookie: ownerCookie },
    });
    expect(tools.status).toBe(200);
    expect(await tools.json()).toEqual({
      tools: [
        {
          name: "fixture.echo",
          description: "Echoes a value.",
          inputSchema: { type: "object" },
        },
      ],
    });

    const otherSession = await fetch(`${base}/api/session`);
    const otherCookie = cookiePair(otherSession);
    const denied = await fetch(`${base}/api/tools`, {
      headers: { cookie: otherCookie },
    });
    expect(denied.status).toBe(409);
    expect(await denied.text()).not.toContain("fixture.echo");

    const anonymous = await fetch(`${base}/api/tools`);
    expect(anonymous.status).toBe(403);
  });

  it("bounds browser sessions while preserving the active target owner", async () => {
    const controller = createController();
    const server = await startOnAvailablePort((port) =>
      startAttachedDevtoolsServer({ port, controller }),
    );
    servers.push(server);
    const base = `http://127.0.0.1:${String(server.address().port)}`;

    const ownerSession = await fetch(`${base}/api/session`);
    const ownerCookie = cookiePair(ownerSession);
    const ownerCsrf = ((await ownerSession.json()) as { csrfToken: string })
      .csrfToken;
    await fetch(`${base}/api/connection`, {
      method: "POST",
      headers: mutationHeaders(base, ownerCookie, ownerCsrf),
      body: JSON.stringify({ transport: "stdio", command: "fixture-mcp" }),
    });

    let oldestForeignCookie = "";
    for (let index = 0; index < 130; index += 1) {
      const foreignSession = await fetch(`${base}/api/session`);
      if (index === 0) oldestForeignCookie = cookiePair(foreignSession);
      await foreignSession.body?.cancel();
    }

    const ownerTools = await fetch(`${base}/api/tools`, {
      headers: { cookie: ownerCookie },
    });
    expect(ownerTools.status).toBe(200);

    const evictedTools = await fetch(`${base}/api/tools`, {
      headers: { cookie: oldestForeignCookie },
    });
    expect(evictedTools.status).toBe(403);
  });

  it("rejects non-exact JSON and oversized connection bodies before connect", async () => {
    const controller = createController();
    const server = await startOnAvailablePort((port) =>
      startAttachedDevtoolsServer({ port, controller }),
    );
    servers.push(server);
    const base = `http://127.0.0.1:${String(server.address().port)}`;
    const session = await fetch(`${base}/api/session`);
    const cookie = cookiePair(session);
    const csrf = ((await session.json()) as { csrfToken: string }).csrfToken;

    const wrongType = await fetch(`${base}/api/connection`, {
      method: "POST",
      headers: {
        ...mutationHeaders(base, cookie, csrf),
        "content-type": "application/json; charset=utf-8",
      },
      body: "{}",
    });
    expect(wrongType.status).toBe(400);

    const oversized = await fetch(`${base}/api/connection`, {
      method: "POST",
      headers: mutationHeaders(base, cookie, csrf),
      body: JSON.stringify({ padding: "x".repeat(1024 * 1024) }),
    });
    expect(oversized.status).toBe(413);
    expect(controller.connect).not.toHaveBeenCalled();
  });

  it("closes the attached controller with the HTTP server", async () => {
    const controller = createController();
    const server = await startOnAvailablePort((port) =>
      startAttachedDevtoolsServer({ port, controller }),
    );
    servers.push(server);

    await server.close();

    expect(controller.close).toHaveBeenCalledTimes(1);
    servers.splice(servers.indexOf(server), 1);
  });
});
