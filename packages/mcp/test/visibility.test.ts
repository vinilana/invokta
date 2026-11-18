import {
  createEngine,
  defineCapability,
  type EngineEvent,
  type Principal,
} from "@invokta/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  connectMcpClient,
  createMcpHttpHandler,
  type McpCapabilityVisibility,
  serveMcpHttp,
  serveMcpStdio,
} from "../src/index.js";

const HEADERS = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
} as const;

function createVisibilityEngine(events: EngineEvent[] = []) {
  const capability = (description: string) =>
    defineCapability({
      description,
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      access: "authenticated",
      async run() {
        return { ok: true };
      },
    });
  return createEngine({
    name: "visibility-engine",
    version: "0.1.0",
    onEvent: (event) => {
      events.push(event);
    },
    capabilities: {
      "billing.get-invoice": capability("Read one invoice."),
      "billing.refund": capability("Refund one invoice."),
      "admin.purge": capability("Purge every record."),
    },
  });
}

const principals: Record<string, Principal> = {
  "reader-token": { id: "reader", attributes: { scopes: ["billing:read"] } },
  "admin-token": { id: "admin", attributes: { scopes: ["admin"] } },
};

const visibility: McpCapabilityVisibility = ({ principal, capabilityId }) => {
  const scopes = principal?.attributes?.scopes;
  if (!Array.isArray(scopes)) return false;
  if (scopes.includes("admin")) return true;
  return capabilityId === "billing.get-invoice";
};

function handlerFor(
  options: { visibility?: unknown; events?: EngineEvent[] } = {},
) {
  return createMcpHttpHandler(createVisibilityEngine(options.events), {
    ...(options.visibility === undefined
      ? {}
      : { visibility: options.visibility as McpCapabilityVisibility }),
    auth: {
      mode: "required",
      authenticate: ({ headers }) => {
        const token = headers.get("authorization")?.replace("Bearer ", "");
        return token === undefined ? null : (principals[token] ?? null);
      },
    },
  });
}

async function rpc(
  handler: (request: Request) => Promise<Response>,
  token: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await handler(
    new Request("http://127.0.0.1/mcp", {
      method: "POST",
      headers: { ...HEADERS, authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }),
    }),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

async function toolNames(
  handler: (request: Request) => Promise<Response>,
  token: string,
): Promise<string[]> {
  const body = await rpc(handler, token, { method: "tools/list" });
  return (body.result as { tools: { name: string }[] }).tools.map(
    (tool) => tool.name,
  );
}

describe("MCP capability visibility", () => {
  it("lists every tool when no visibility is configured", async () => {
    expect(await toolNames(handlerFor(), "reader-token")).toEqual([
      "billing_get-invoice",
      "billing_refund",
      "admin_purge",
    ]);
  });

  it("lists only the tools visible to the authenticated principal", async () => {
    const handler = handlerFor({ visibility });

    expect(await toolNames(handler, "reader-token")).toEqual([
      "billing_get-invoice",
    ]);
    expect(await toolNames(handler, "admin-token")).toEqual([
      "billing_get-invoice",
      "billing_refund",
      "admin_purge",
    ]);
  });

  it("answers a hidden tool exactly like a nonexistent one, without invoking", async () => {
    const events: EngineEvent[] = [];
    const handler = handlerFor({ visibility, events });

    const hidden = await rpc(handler, "reader-token", {
      method: "tools/call",
      params: { name: "billing_refund", arguments: {} },
    });
    const missing = await rpc(handler, "reader-token", {
      method: "tools/call",
      params: { name: "billing_missing", arguments: {} },
    });

    expect(hidden.error).toMatchObject({ code: -32602 });
    expect(JSON.stringify(hidden.error)).toContain("billing_refund");
    expect(
      JSON.stringify(missing.error).replace("billing_missing", "<tool>"),
    ).toBe(JSON.stringify(hidden.error).replace("billing_refund", "<tool>"));
    expect(events).toEqual([]);

    const visible = await rpc(handler, "reader-token", {
      method: "tools/call",
      params: { name: "billing_get-invoice", arguments: {} },
    });
    expect(visible.result).toMatchObject({ structuredContent: { ok: true } });
  });

  it("hides a capability whose predicate throws or returns a non-boolean", async () => {
    const handler = handlerFor({
      visibility: (({ capabilityId }) => {
        if (capabilityId === "admin.purge") throw new Error("broken");
        return capabilityId === "billing.refund" ? "yes" : true;
      }) as McpCapabilityVisibility,
    });

    expect(await toolNames(handler, "admin-token")).toEqual([
      "billing_get-invoice",
    ]);
  });

  it("passes the predicate a frozen principal that cannot change the invocation", async () => {
    const seen: Array<Principal | null> = [];
    const handler = handlerFor({
      visibility: (({ principal }) => {
        seen.push(principal);
        return true;
      }) satisfies McpCapabilityVisibility,
    });

    await toolNames(handler, "reader-token");
    expect(seen[0]).toEqual(principals["reader-token"]);
    expect(Object.isFrozen(seen[0])).toBe(true);
    expect(Object.isFrozen(seen[0]?.attributes)).toBe(true);
  });

  it("filters through the Node.js listener of serveMcpHttp", async () => {
    const server = await serveMcpHttp(createVisibilityEngine(), {
      port: 0,
      visibility,
      auth: {
        mode: "required",
        authenticate: ({ headers }) => {
          const token = headers.get("authorization")?.replace("Bearer ", "");
          return token === undefined ? null : (principals[token] ?? null);
        },
      },
    });
    try {
      const { host, port } = server.address();
      const client = await connectMcpClient({
        transport: "http",
        url: `http://${host}:${String(port)}/mcp`,
        authentication: { type: "bearer", token: "reader-token" },
      });
      try {
        expect(
          (await client.listTools()).tools.map((tool) => tool.name),
        ).toEqual(["billing_get-invoice"]);
      } finally {
        await client.close();
      }
    } finally {
      await server.close();
    }
  });

  it("applies visibility to the null principal when authentication is disabled", async () => {
    const seen: Array<Principal | null> = [];
    const handler = createMcpHttpHandler(createVisibilityEngine(), {
      visibility: ({ principal, capabilityId }) => {
        seen.push(principal);
        return capabilityId === "billing.get-invoice";
      },
      auth: { mode: "dangerously-disabled-for-development" },
    });

    const response = await handler(
      new Request("http://127.0.0.1/mcp", {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    const body = (await response.json()) as {
      result: { tools: { name: string }[] };
    };

    expect(body.result.tools.map((tool) => tool.name)).toEqual([
      "billing_get-invoice",
    ]);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((principal) => principal === null)).toBe(true);
  });

  it("rejects an invalid visibility option before serving", async () => {
    expect(() => handlerFor({ visibility: "all" })).toThrow(
      new TypeError("visibility must be a function."),
    );
    await expect(
      serveMcpStdio(createVisibilityEngine(), {
        visibility: 1 as unknown as McpCapabilityVisibility,
      }),
    ).rejects.toThrow(new TypeError("visibility must be a function."));
  });

  it("calls the predicate only with the principal and the capability ID", async () => {
    const predicate = vi.fn(() => true);
    await toolNames(handlerFor({ visibility: predicate }), "reader-token");

    expect(predicate).toHaveBeenCalledWith({
      principal: principals["reader-token"],
      capabilityId: "billing.refund",
    });
  });
});
