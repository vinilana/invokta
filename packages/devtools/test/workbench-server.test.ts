import { createConnection } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AttachedServerController } from "../src/attached-server.js";
import type { AttachedCliServerController } from "../src/cli-attached-server.js";
import { startWorkbenchDevtoolsServer } from "../src/workbench-server.js";
import { startOnAvailablePort } from "./available-port.js";

const mcpConnection = {
  transport: "stdio",
  server: {
    name: "fixture-server",
    version: "1.0.0",
    protocolVersion: "2025-11-25",
  },
  toolCount: 1,
  pageCount: 1,
  validation: { status: "ok" },
} as const;

const cliConnection = {
  command: "node",
  capabilityCount: 1,
  validation: { status: "ok" },
} as const;

function createMcpController(): AttachedServerController & {
  readonly close: ReturnType<typeof vi.fn>;
  readonly beginOAuth: ReturnType<typeof vi.fn>;
} {
  const owners = new Set<string>();
  return {
    state: (owner) =>
      owners.has(owner)
        ? { state: "connected", connection: mcpConnection }
        : { state: "idle" },
    connect: vi.fn(async (owner: string) => {
      owners.add(owner);
      return mcpConnection;
    }),
    beginOAuth: vi.fn(
      async (
        _owner: string,
        _target: unknown,
        options: { readonly state: string },
      ) => ({
        authorizationUrl: `https://identity.example.test/authorize?state=${options.state}`,
      }),
    ),
    completeOAuth: vi.fn(async () => mcpConnection),
    rejectOAuth: vi.fn(async () => undefined),
    tools: (owner) => {
      if (!owners.has(owner)) throw new Error("not connected");
      return [{ name: "fixture.echo", inputSchema: { type: "object" } }];
    },
    call: vi.fn(async () => ({ response: { content: [] } })),
    activity: (owner) => {
      if (!owners.has(owner)) throw new Error("not connected");
      return [];
    },
    disconnect: vi.fn(async (owner: string) => {
      owners.delete(owner);
    }),
    close: vi.fn(async () => {
      owners.clear();
    }),
  };
}

function createCliController(): AttachedCliServerController & {
  readonly close: ReturnType<typeof vi.fn>;
} {
  const owners = new Set<string>();
  return {
    state: (owner) =>
      owners.has(owner)
        ? { state: "connected", connection: cliConnection }
        : { state: "idle" },
    connect: vi.fn(async (owner: string) => {
      owners.add(owner);
      return cliConnection;
    }),
    refresh: vi.fn(async () => cliConnection),
    describe: vi.fn(async (_owner: string, id: string) => ({
      id,
      description: "Echoes a value.",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
    })),
    run: vi.fn(async () => ({ ok: true })),
    catalog: (owner) => {
      if (!owners.has(owner)) throw new Error("not connected");
      return [{ id: "fixture.echo", description: "Echoes a value." }];
    },
    description: () => undefined,
    activity: (owner) => {
      if (!owners.has(owner)) throw new Error("not connected");
      return [];
    },
    disconnect: vi.fn(async (owner: string) => {
      owners.delete(owner);
    }),
    close: vi.fn(async () => {
      owners.clear();
    }),
  };
}

/**
 * A Host header a browser can send but `fetch` refuses to set, so the
 * launcher's own rebinding guard is exercised over a raw socket.
 */
function rawHostRequest(
  port: number,
  host: string,
): Promise<{ readonly status: number }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("Raw HTTP fixture timed out."));
    }, 1_000);
    socket.once("connect", () => {
      socket.write(
        ["GET / HTTP/1.1", `Host: ${host}`, "Connection: close", "", ""].join(
          "\r\n",
        ),
      );
      socket.end();
    });
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("end", () => {
      clearTimeout(timeout);
      const raw = Buffer.concat(chunks).toString("utf8");
      resolve({ status: Number(raw.match(/^HTTP\/1\.1 (\d{3})/u)?.[1]) });
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function cookiePair(response: Response): string {
  const value = response.headers.get("set-cookie");
  if (value === null) throw new Error("session cookie missing");
  return value.split(";", 1)[0] as string;
}

const servers: Array<Awaited<ReturnType<typeof startWorkbenchDevtoolsServer>>> =
  [];

async function startLauncher(
  overrides: {
    readonly mcpController?: AttachedServerController;
    readonly cliController?: AttachedCliServerController;
  } = {},
): Promise<{
  readonly server: Awaited<ReturnType<typeof startWorkbenchDevtoolsServer>>;
  readonly base: string;
}> {
  const server = await startOnAvailablePort((port) =>
    startWorkbenchDevtoolsServer({
      port,
      mcpController: overrides.mcpController ?? createMcpController(),
      cliController: overrides.cliController ?? createCliController(),
    }),
  );
  servers.push(server);
  const address = server.address();
  return { server, base: `http://${address.host}:${String(address.port)}` };
}

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
  vi.restoreAllMocks();
});

describe("workbench launcher", () => {
  it("opens on a chooser that reaches both workbenches", async () => {
    const { server, base } = await startLauncher();

    expect(server.path()).toBe("/");
    expect(server.path("mcp")).toBe("/mcp");
    expect(server.path("cli")).toBe("/cli");

    const chooser = await fetch(`${base}/`);
    expect(chooser.status).toBe(200);
    expect(chooser.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    const page = await chooser.text();
    expect(page).toContain("<title>Invokta DevTools</title>");
    expect(page).toContain('src="/assets/chooser-app.js"');
  });

  it("serves each workbench shell with its own API mount", async () => {
    const { base } = await startLauncher();

    const mcp = await fetch(`${base}/mcp`);
    expect(mcp.status).toBe(200);
    const mcpPage = await mcp.text();
    expect(mcpPage).toContain(
      "<title>Invokta DevTools · MCP workbench</title>",
    );
    expect(mcpPage).toContain('data-invokta-api="/api/mcp"');
    expect(mcpPage).toContain('data-invokta-workbench="mcp"');
    expect(mcpPage).toContain('src="/assets/attached-app.js"');

    const cli = await fetch(`${base}/cli`);
    expect(cli.status).toBe(200);
    const cliPage = await cli.text();
    expect(cliPage).toContain(
      "<title>Invokta DevTools · CLI workbench</title>",
    );
    expect(cliPage).toContain('data-invokta-api="/api/cli"');
    expect(cliPage).toContain('data-invokta-workbench="cli"');
    expect(cliPage).toContain('src="/assets/cli-app.js"');
  });

  it("keeps the two workbench APIs apart", async () => {
    const mcpController = createMcpController();
    const cliController = createCliController();
    const { base } = await startLauncher({ mcpController, cliController });

    const mcpSession = await fetch(`${base}/api/mcp/session`);
    expect(mcpSession.status).toBe(200);
    const mcpCookie = cookiePair(mcpSession);
    const mcpCsrf = ((await mcpSession.json()) as { csrfToken: string })
      .csrfToken;

    const cliSession = await fetch(`${base}/api/cli/session`);
    expect(cliSession.status).toBe(200);
    const cliCsrf = ((await cliSession.json()) as { csrfToken: string })
      .csrfToken;

    // The unprefixed API of a single-workbench server is not mounted here.
    const unmounted = await fetch(`${base}/api/session`, {
      headers: { cookie: mcpCookie },
    });
    expect(unmounted.status).toBe(404);
    await unmounted.arrayBuffer();

    const connected = await fetch(`${base}/api/mcp/connection`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: mcpCookie,
        origin: base,
        "x-invokta-csrf": mcpCsrf,
      },
      body: JSON.stringify({ transport: "stdio", command: "node" }),
    });
    expect(connected.status).toBe(200);
    expect(mcpController.connect).toHaveBeenCalledOnce();
    expect(cliController.connect).not.toHaveBeenCalled();
    expect(cliCsrf).not.toBe(mcpCsrf);

    // The MCP browser session does not authorize the CLI workbench.
    const crossed = await fetch(`${base}/api/cli/catalog`, {
      headers: { cookie: mcpCookie },
    });
    expect(crossed.status).toBe(403);
  });

  it("serves one shared asset surface", async () => {
    const { base } = await startLauncher();

    const styles = await fetch(`${base}/assets/attached.css`);
    expect(styles.status).toBe(200);
    expect(styles.headers.get("content-type")).toContain("text/css");
    expect(await styles.text()).toContain(".att-choice");

    const favicon = await fetch(`${base}/assets/favicon.svg`);
    expect(favicon.status).toBe(200);
    expect(favicon.headers.get("content-type")).toBe("image/svg+xml");
    await favicon.arrayBuffer();

    const missing = await fetch(`${base}/assets/not-shipped.js`);
    expect(missing.status).toBe(404);
    await missing.arrayBuffer();
  });

  it("keeps the OAuth callback on the launcher root", async () => {
    const mcpController = createMcpController();
    const { base } = await startLauncher({ mcpController });
    const session = await fetch(`${base}/api/mcp/session`);
    const cookie = cookiePair(session);
    const csrf = ((await session.json()) as { csrfToken: string }).csrfToken;

    const started = await fetch(`${base}/api/mcp/connection`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        origin: base,
        "x-invokta-csrf": csrf,
      },
      body: JSON.stringify({
        transport: "http",
        url: "https://mcp.example.test/rpc",
        authentication: { type: "oauth" },
      }),
    });
    expect(started.status).toBe(202);

    const port = servers[0]?.address().port as number;
    expect(mcpController.beginOAuth).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      expect.objectContaining({
        redirectUrl: `http://127.0.0.1:${String(port)}/oauth/callback`,
      }),
    );

    const callback = await fetch(`${base}/oauth/callback`, {
      redirect: "manual",
    });
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe("/oauth/result/invalid");
    await callback.arrayBuffer();
  });

  it("refuses a foreign host and closes both controllers", async () => {
    const mcpController = createMcpController();
    const cliController = createCliController();
    const { server } = await startLauncher({ mcpController, cliController });

    const refused = await rawHostRequest(
      server.address().port,
      "attacker.example",
    );
    expect(refused.status).toBe(403);

    await server.close();
    expect(mcpController.close).toHaveBeenCalledTimes(1);
    expect(cliController.close).toHaveBeenCalledTimes(1);
    servers.splice(servers.indexOf(server), 1);
  });
});
