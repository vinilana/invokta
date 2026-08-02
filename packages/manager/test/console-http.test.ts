import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNodeFileSystem } from "@invokta/installer-core";
import { afterAll, describe, expect, it } from "vitest";

import { createConsoleServer } from "../src/console-server.js";
import { createConsoleService } from "../src/console-service.js";
import { createConsoleSession } from "../src/session.js";

const homes: string[] = [];
const servers: Server[] = [];

afterAll(async () => {
  for (const server of servers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const home of homes) rmSync(home, { force: true, recursive: true });
});

const secretValue = "super-secret-environment-value";

interface Harness {
  readonly home: string;
  readonly cursorConfig: string;
  readonly base: string;
  readonly token: string;
  readonly port: number;
}

function writeProject(workspace: string, id: string, built = true): void {
  const directory = join(workspace, id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "invokta.mcp.json"),
    JSON.stringify({
      schemaVersion: 1,
      id,
      version: "1.0.0",
      title: `${id} engine`,
      description: `${id} fixture.`,
      capabilityIds: [`${id}.ping`],
      server: { name: id, entrypoint: "dist/mcp-stdio.js", forwardEnv: [] },
    }),
  );
  if (built) {
    mkdirSync(join(directory, "dist"), { recursive: true });
    writeFileSync(
      join(directory, "dist", "mcp-stdio.js"),
      "process.exit(0);\n",
    );
  }
}

async function harness(): Promise<Harness> {
  const home = mkdtempSync(join(tmpdir(), "invokta-console-"));
  homes.push(home);
  const workspace = join(home, "workspace");
  const cursorConfig = join(home, ".cursor", "mcp.json");
  mkdirSync(join(home, ".cursor"), { recursive: true });
  mkdirSync(join(home, ".state"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(
    cursorConfig,
    '{\n  "mcpServers": {\n    "unrelated": { "command": "true", "args": [] }\n  }\n}\n',
  );
  writeProject(workspace, "demo");
  writeProject(workspace, "unbuilt", false);

  const service = await createConsoleService({
    scanRoots: [workspace],
    fileSystem: createNodeFileSystem(),
    environment: {
      get: (name) =>
        name === "XDG_STATE_HOME"
          ? join(home, ".state")
          : name === "SECRET_TOKEN"
            ? secretValue
            : undefined,
    },
    resolveExecutable: async () => undefined,
    resolveHomeDirectory: () => home,
    platform: "linux",
  });
  const session = createConsoleSession();
  const server = createConsoleServer({ service, session });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    home,
    cursorConfig,
    base: `http://127.0.0.1:${String(port)}`,
    token: session.token,
    port,
  };
}

function rawRequest(
  harnessed: Harness,
  host: string,
): Promise<{ readonly status: number }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: harnessed.port,
        path: "/api/inventory",
        method: "GET",
        headers: {
          host,
          authorization: `Bearer ${harnessed.token}`,
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve({ status: response.statusCode ?? 0 }));
      },
    );
    request.on("error", reject);
    request.end();
  });
}

function authorized(harnessed: Harness, extra: Record<string, string> = {}) {
  return { authorization: `Bearer ${harnessed.token}`, ...extra };
}

async function inventory(harnessed: Harness, refresh = false) {
  const response = await fetch(
    `${harnessed.base}/api/inventory${refresh ? "?refresh=1" : ""}`,
    { headers: authorized(harnessed) },
  );
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    readonly engines: readonly {
      readonly id: string;
      readonly cells: Record<
        string,
        { readonly state: string; readonly status?: string }
      >;
      readonly installPreview?: { readonly command?: string };
    }[];
    readonly targets: readonly { readonly id: string }[];
    readonly discovery: { readonly rejected: readonly unknown[] };
  }>;
}

async function act(
  harnessed: Harness,
  action: string,
  engineId: string,
  targetIds: readonly string[],
) {
  const response = await fetch(`${harnessed.base}/api/action`, {
    method: "POST",
    headers: authorized(harnessed, { "content-type": "application/json" }),
    body: JSON.stringify({ action, engineId, targetIds }),
  });
  return { status: response.status, body: (await response.json()) as never };
}

function cellState(
  snapshot: Awaited<ReturnType<typeof inventory>>,
  engineId: string,
  targetId: string,
): string {
  const engine = snapshot.engines.find((entry) => entry.id === engineId);
  const cell = engine?.cells[targetId];
  return cell?.state === "managed"
    ? (cell.status ?? "managed")
    : (cell?.state ?? "missing");
}

describe("console transport", () => {
  it("serves the page only with the session token and returns no inventory in it", async () => {
    const harnessed = await harness();

    const denied = await fetch(`${harnessed.base}/?token=wrong`);
    const granted = await fetch(`${harnessed.base}/?token=${harnessed.token}`);
    const page = await granted.text();

    expect(denied.status).toBe(403);
    expect(granted.status).toBe(200);
    expect(granted.headers.get("content-type")).toContain("text/html");
    expect(granted.headers.get("cache-control")).toBe("no-store");
    expect(granted.headers.get("x-content-type-options")).toBe("nosniff");
    expect(granted.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(granted.headers.get("set-cookie")).toBeNull();
    expect(granted.headers.get("access-control-allow-origin")).toBeNull();
    expect(page).not.toContain("demo");
    expect(page).not.toContain(harnessed.home);
  });

  it("rejects a missing, wrong, or malformed bearer token", async () => {
    const harnessed = await harness();

    const none = await fetch(`${harnessed.base}/api/inventory`);
    const wrong = await fetch(`${harnessed.base}/api/inventory`, {
      headers: { authorization: `Bearer ${"a".repeat(43)}` },
    });
    const malformed = await fetch(`${harnessed.base}/api/inventory`, {
      headers: { authorization: harnessed.token },
    });
    const queryOnly = await fetch(
      `${harnessed.base}/api/inventory?token=${harnessed.token}`,
    );

    expect(none.status).toBe(403);
    expect(wrong.status).toBe(403);
    expect(malformed.status).toBe(403);
    expect(queryOnly.status).toBe(403);
  });

  it("rejects a foreign host, a foreign origin, and a cross-site fetch", async () => {
    const harnessed = await harness();

    // `fetch` refuses to set `Host`, so a DNS-rebinding attempt is reproduced
    // with a raw request instead.
    const foreignHost = await rawRequest(harnessed, "evil.test");
    const foreignOrigin = await fetch(`${harnessed.base}/api/inventory`, {
      headers: authorized(harnessed, { origin: "http://evil.test" }),
    });
    const crossSite = await fetch(`${harnessed.base}/api/inventory`, {
      headers: authorized(harnessed, { "sec-fetch-site": "cross-site" }),
    });
    const sameOrigin = await fetch(`${harnessed.base}/api/inventory`, {
      headers: authorized(harnessed, {
        origin: `http://localhost:${String(harnessed.port)}`,
        "sec-fetch-site": "same-origin",
      }),
    });

    expect(foreignHost.status).toBe(403);
    expect(foreignOrigin.status).toBe(403);
    expect(crossSite.status).toBe(403);
    expect(sameOrigin.status).toBe(200);
  });

  it("rejects an unknown route and an invalid action body", async () => {
    const harnessed = await harness();

    const unknown = await fetch(`${harnessed.base}/api/nothing`, {
      headers: authorized(harnessed),
    });
    const badAction = await act(harnessed, "purge", "demo", ["cursor"]);
    const noTargets = await act(harnessed, "install", "demo", []);

    expect(unknown.status).toBe(404);
    expect(badAction.status).toBe(400);
    expect(noTargets.status).toBe(400);
  });
});

describe("console inventory", () => {
  it("classifies the discovered projects and never leaks an environment value", async () => {
    const harnessed = await harness();

    const response = await fetch(`${harnessed.base}/api/inventory`, {
      headers: authorized(harnessed),
    });
    const raw = await response.text();
    const snapshot = JSON.parse(raw) as Awaited<ReturnType<typeof inventory>>;

    expect(cellState(snapshot, "demo", "cursor")).toBe("installable");
    expect(cellState(snapshot, "unbuilt", "cursor")).toBe("needs-build");
    expect(snapshot.discovery.rejected).toEqual([]);
    expect(raw).not.toContain(secretValue);
    expect(raw).not.toContain(harnessed.token);
  });

  it("previews the exact command an install would write", async () => {
    const harnessed = await harness();

    const snapshot = await inventory(harnessed);
    const demo = snapshot.engines.find((engine) => engine.id === "demo");

    expect(demo?.installPreview?.command).toBe(process.execPath);
  });
});

describe("console lifecycle", () => {
  it("installs, disables, enables, and removes over HTTP", async () => {
    const harnessed = await harness();
    const before = readFileSync(harnessed.cursorConfig, "utf8");

    const installed = await act(harnessed, "install", "demo", ["cursor"]);
    expect(installed.status).toBe(200);
    expect(installed.body).toMatchObject({
      results: [{ targetId: "cursor", outcome: "installed" }],
    });
    expect(cellState(await inventory(harnessed), "demo", "cursor")).toBe(
      "enabled",
    );

    const disabled = await act(harnessed, "disable", "demo", ["cursor"]);
    expect(disabled.status).toBe(200);
    expect(cellState(await inventory(harnessed), "demo", "cursor")).toBe(
      "disabled",
    );

    const enabled = await act(harnessed, "enable", "demo", ["cursor"]);
    expect(enabled.status).toBe(200);
    expect(cellState(await inventory(harnessed), "demo", "cursor")).toBe(
      "enabled",
    );

    const removed = await act(harnessed, "remove", "demo", ["cursor"]);
    expect(removed.status).toBe(200);
    expect(cellState(await inventory(harnessed), "demo", "cursor")).toBe(
      "installable",
    );

    expect(readFileSync(harnessed.cursorConfig, "utf8")).toBe(before);
  });

  it("refuses to install an unbuilt project and writes nothing", async () => {
    const harnessed = await harness();
    const before = readFileSync(harnessed.cursorConfig, "utf8");

    const result = await act(harnessed, "install", "unbuilt", ["cursor"]);

    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ code: "ENGINE_ENTRYPOINT_MISSING" });
    expect(readFileSync(harnessed.cursorConfig, "utf8")).toBe(before);
  });

  it("refuses a management action on a registration it does not own", async () => {
    const harnessed = await harness();

    const result = await act(harnessed, "disable", "demo", ["cursor"]);

    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ code: "INSTALLATION_UNAVAILABLE" });
  });

  it("rejects a second mutation while one is in flight", async () => {
    const harnessed = await harness();

    const [first, second] = await Promise.all([
      act(harnessed, "install", "demo", ["cursor"]),
      act(harnessed, "install", "demo", ["cursor"]),
    ]);
    const statuses = [first.status, second.status].sort();

    expect(statuses).toEqual([200, 409]);
    expect(cellState(await inventory(harnessed), "demo", "cursor")).toBe(
      "enabled",
    );
  });
});
