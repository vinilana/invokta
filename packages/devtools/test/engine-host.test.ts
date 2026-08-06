import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  createEngine,
  defineCapability,
  type EngineEvent,
  type EngineSchema,
} from "@invokta/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type InvocationRecord, startEngineHost } from "../src/engine-host.js";
import {
  createPrincipalStore,
  defaultPrincipalId,
} from "../src/principal-store.js";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const devtoolsOrigin = "http://127.0.0.1:4100";

type FixtureValue = Readonly<Record<string, unknown>>;

const fixtureSchema = {
  "~standard": {
    version: 1,
    vendor: "invokta-devtools-test",
    validate: (value: unknown) => {
      if (
        typeof value === "object" &&
        value !== null &&
        (value as { readonly fail?: unknown }).fail === true
      ) {
        return {
          issues: [{ message: "The fixture input requested failure." }],
        };
      }
      return { value };
    },
    jsonSchema: {
      input: () => ({ type: "object" }),
      output: () => ({ type: "object" }),
    },
  },
} as unknown as EngineSchema<FixtureValue, FixtureValue>;

function buildEngine(events: EngineEvent[]) {
  return createEngine({
    name: "host-test-engine",
    version: "0.1.0",
    onEvent: (event) => {
      events.push(event);
    },
    capabilities: {
      "fixture.echo": defineCapability({
        description: "Echoes the fixture input.",
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

describe("startEngineHost", () => {
  const events: EngineEvent[] = [];
  const records: InvocationRecord[] = [];
  const engine = buildEngine(events);
  const store = createPrincipalStore();
  const token = store.list()[0]?.token as string;
  let mcpUrl = "";
  let close: () => Promise<void> = async () => undefined;

  beforeAll(async () => {
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

    const host = await startEngineHost({
      engine,
      allowedOrigin: devtoolsOrigin,
      authenticate: store.authenticate,
      onRecord: (record) => {
        records.push(record);
      },
    });
    close = () => host.close();
    const address = host.address();
    mcpUrl = `http://${address.host}:${String(address.port)}/mcp`;
  });

  afterAll(async () => {
    await close();
  });

  function postMcp(
    body: unknown,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<Response> {
    return fetch(mcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }

  function callEcho(
    args: FixtureValue,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<Response> {
    return postMcp(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "fixture.echo", arguments: args },
      },
      headers,
    );
  }

  it("executes an authenticated tools/call through the single invoke path", async () => {
    events.length = 0;
    records.length = 0;

    const response = await callEcho(
      { message: "hello" },
      { authorization: `Bearer ${token}` },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly result: { readonly structuredContent: unknown };
    };
    const direct = await engine.invoke(
      "fixture.echo",
      { message: "hello" },
      { source: "direct" },
    );
    expect(body.result.structuredContent).toEqual(direct);

    expect(records).toHaveLength(1);
    const record = records[0] as InvocationRecord;
    expect(record.capabilityId).toBe("fixture.echo");
    expect(record.outcome).toBe("completed");
    expect(record.durationMs).toBeGreaterThanOrEqual(0);
    expect(record.errorCode).toBeUndefined();
  });

  it("keeps the engine's own onEvent hook firing with source mcp-http", async () => {
    events.length = 0;

    await callEcho({ message: "events" }, { authorization: `Bearer ${token}` });

    const started = events.find((event) => event.type === "invocation.started");
    expect(started).toBeDefined();
    expect(started?.type === "invocation.started" && started.source).toBe(
      "mcp-http",
    );
    expect(started?.type === "invocation.started" && started.principalId).toBe(
      defaultPrincipalId,
    );
    expect(events.some((event) => event.type === "invocation.completed")).toBe(
      true,
    );
  });

  it("records a failed invocation with its engine error code", async () => {
    records.length = 0;

    const response = await callEcho(
      { fail: true },
      { authorization: `Bearer ${token}` },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly result: { readonly isError?: boolean };
    };
    expect(body.result.isError).toBe(true);

    expect(records).toHaveLength(1);
    const record = records[0] as InvocationRecord;
    expect(record.outcome).toBe("failed");
    expect(record.errorCode).toBe("INPUT_INVALID");
  });

  it("matches the bearer scheme case-insensitively", async () => {
    const response = await callEcho(
      { message: "case" },
      { authorization: `BEARER ${token}` },
    );

    expect(response.status).toBe(200);
  });

  it("answers a missing token with the adapter's own 401 challenge", async () => {
    records.length = 0;

    const response = await callEcho({ message: "anonymous" });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(records).toHaveLength(0);
  });

  it("rejects an unknown token with 401", async () => {
    const response = await callEcho(
      { message: "unknown" },
      { authorization: "Bearer not-a-minted-token" },
    );

    expect(response.status).toBe(401);
  });

  it("rejects a foreign origin with 403 before authentication", async () => {
    records.length = 0;

    const response = await callEcho(
      { message: "foreign" },
      {
        authorization: `Bearer ${token}`,
        origin: "http://attacker.example",
      },
    );

    expect(response.status).toBe(403);
    expect(records).toHaveLength(0);
  });

  it("accepts the devtools origin", async () => {
    const response = await callEcho(
      { message: "same-origin" },
      { authorization: `Bearer ${token}`, origin: devtoolsOrigin },
    );

    expect(response.status).toBe(200);
  });
});

describe("createPrincipalStore", () => {
  it("starts with the default development principal", () => {
    const store = createPrincipalStore();
    const principals = store.list();

    expect(principals).toHaveLength(1);
    expect(principals[0]?.principal.id).toBe(defaultPrincipalId);
    expect(principals[0]?.token).toBeTruthy();
  });

  it("issues distinct tokens and resolves them to snapshots", () => {
    const store = createPrincipalStore();
    const attributes: Record<string, unknown> = { role: "reviewer" };
    const supplied = { id: "reviewer", attributes };
    const issued = store.issue(supplied);

    expect(issued.token).not.toBe(store.list()[0]?.token);
    expect(store.resolve(issued.token)).toEqual(supplied);

    // The store keeps a snapshot, so later caller mutation cannot leak in.
    attributes.role = "admin";
    expect(store.resolve(issued.token)).toEqual({
      id: "reviewer",
      attributes: { role: "reviewer" },
    });
  });

  it("revokes tokens", () => {
    const store = createPrincipalStore();
    const issued = store.issue({ id: "temporary" });

    expect(store.revoke(issued.token)).toBe(true);
    expect(store.resolve(issued.token)).toBeNull();
    expect(store.revoke(issued.token)).toBe(false);
  });

  it("authenticates only well-formed bearer headers", () => {
    const store = createPrincipalStore();
    const token = store.list()[0]?.token as string;
    const request = (header: string | null) => ({
      path: "/mcp",
      method: "POST",
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "authorization" ? header : null,
        has: (name: string) =>
          name.toLowerCase() === "authorization" && header !== null,
      },
      signal: new AbortController().signal,
    });

    expect(store.authenticate(request(`Bearer ${token}`))?.id).toBe(
      defaultPrincipalId,
    );
    expect(store.authenticate(request(`bearer ${token}`))?.id).toBe(
      defaultPrincipalId,
    );
    expect(store.authenticate(request(null))).toBeNull();
    expect(store.authenticate(request(token))).toBeNull();
    expect(store.authenticate(request("Bearer"))).toBeNull();
    expect(store.authenticate(request("Basic dXNlcjpwYXNz"))).toBeNull();
  });
});
