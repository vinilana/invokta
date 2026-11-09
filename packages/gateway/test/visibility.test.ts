import { createEngine, type Principal } from "@invokta/core";
import { createMcpHttpHandler } from "@invokta/mcp";
import { describe, expect, it } from "vitest";

import {
  createGateway,
  engineUpstream,
  type GatewayRule,
  requireScopes,
} from "../src/index.js";
import { createBillingEngine, createSupportEngine } from "./support/engines.js";

const agent: Principal = {
  id: "agent",
  attributes: { scopes: ["billing:refund"], team: "support" },
};
const reader: Principal = { id: "reader" };

function gatewayWith(
  rules: ReadonlyArray<GatewayRule>,
  defaultAccess?: "deny" | "authenticated" | (() => boolean),
) {
  return createGateway({
    upstreams: [
      engineUpstream({ name: "billing", engine: createBillingEngine() }),
      engineUpstream({ name: "support", engine: createSupportEngine() }),
    ],
    rules,
    ...(defaultAccess === undefined ? {} : { defaultAccess }),
  });
}

function visibleIds(
  gateway: ReturnType<typeof createGateway>,
  principal: Principal | null,
): string[] {
  return gateway.routes
    .map((route) => route.capabilityId)
    .filter((capabilityId) => gateway.visibility({ principal, capabilityId }));
}

describe("gateway.visibility", () => {
  it("derives visibility from each capability's governing rule", () => {
    const gateway = gatewayWith([
      { name: "invoice", match: "billing.get-invoice", access: "public" },
      {
        name: "refund",
        match: "billing.refund",
        access: requireScopes("billing:refund"),
      },
      {
        name: "classify",
        match: "support.classify-ticket",
        access: "authenticated",
      },
      { name: "close", match: "support.close-ticket", access: "deny" },
    ]);

    expect(visibleIds(gateway, null)).toEqual(["billing.get-invoice"]);
    expect(visibleIds(gateway, reader)).toEqual([
      "billing.get-invoice",
      "support.classify-ticket",
    ]);
    expect(visibleIds(gateway, agent)).toEqual([
      "billing.get-invoice",
      "billing.refund",
      "support.classify-ticket",
    ]);
  });

  it("shows a custom function rule to every authenticated caller unless it declares visible", () => {
    const gateway = gatewayWith([
      {
        name: "team-only",
        match: "support.*",
        access: ({ principal }) => principal?.attributes?.team === "support",
        visible: (principal) => principal?.attributes?.team === "support",
      },
      {
        name: "input-dependent",
        match: "billing.*",
        access: ({ input }) => input.invoiceId !== "I-0",
      },
    ]);

    expect(visibleIds(gateway, null)).toEqual([]);
    expect(visibleIds(gateway, reader)).toEqual([
      "billing.get-invoice",
      "billing.refund",
    ]);
    expect(visibleIds(gateway, agent)).toEqual([
      "billing.get-invoice",
      "billing.refund",
      "support.classify-ticket",
      "support.close-ticket",
      "support.wait",
    ]);
  });

  it("hides deny-by-default capabilities and unknown IDs", () => {
    const denied = gatewayWith([
      { match: "billing.get-invoice", access: "public" },
    ]);
    expect(visibleIds(denied, agent)).toEqual(["billing.get-invoice"]);
    expect(
      denied.visibility({ principal: agent, capabilityId: "local.other" }),
    ).toBe(false);

    const authenticatedDefault = gatewayWith(
      [{ match: "billing.get-invoice", access: "public" }],
      () => true,
    );
    expect(visibleIds(authenticatedDefault, null)).toEqual([
      "billing.get-invoice",
    ]);
    expect(visibleIds(authenticatedDefault, reader)).toHaveLength(5);
  });

  it("hides a capability whose visible predicate throws", () => {
    const gateway = gatewayWith([
      {
        match: "*",
        access: () => true,
        visible: () => {
          throw new Error("directory unavailable");
        },
      },
    ]);

    expect(visibleIds(gateway, agent)).toEqual([]);
  });

  it("rejects a visible predicate that is not a function", () => {
    expect(() =>
      gatewayWith([
        {
          match: "*",
          access: "authenticated",
          visible: true as unknown as () => boolean,
        },
      ]),
    ).toThrow(
      new TypeError("Gateway rule rules[0] visible must be a function."),
    );
  });

  it("filters the MCP tool list per caller through the adapter option", async () => {
    const gateway = gatewayWith([
      { match: "billing.get-invoice", access: "public" },
      { match: "billing.refund", access: requireScopes("billing:refund") },
    ]);
    const handler = createMcpHttpHandler(
      createEngine({
        name: "gateway",
        version: "0.1.0",
        capabilities: gateway.capabilities,
      }),
      {
        visibility: gateway.visibility,
        auth: {
          mode: "required",
          authenticate: ({ headers }) =>
            headers.get("x-user") === "agent" ? agent : reader,
        },
      },
    );
    const tools = async (user: string) => {
      const response = await handler(
        new Request("http://127.0.0.1/mcp", {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            "x-user": user,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        }),
      );
      const body = (await response.json()) as {
        result: { tools: { name: string }[] };
      };
      return body.result.tools.map((tool) => tool.name);
    };

    expect(await tools("reader")).toEqual(["billing_get-invoice"]);
    expect(await tools("agent")).toEqual([
      "billing_get-invoice",
      "billing_refund",
    ]);
  });
});
