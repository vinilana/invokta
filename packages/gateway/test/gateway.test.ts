import { createEngine, EngineError, type Principal } from "@invokta/core";
import { describe, expect, it, vi } from "vitest";

import {
  createGateway,
  engineUpstream,
  type GatewayDecision,
  requireScopes,
} from "../src/index.js";
import { createBillingEngine, createSupportEngine } from "./support/engines.js";

const agent: Principal = {
  id: "agent-1",
  attributes: { agent: true, scopes: ["support:read", "billing:write"] },
};
const viewer: Principal = {
  id: "viewer-1",
  attributes: { scopes: ["support:read"] },
};

async function failure(pending: Promise<unknown>): Promise<EngineError> {
  try {
    await pending;
  } catch (error) {
    if (error instanceof EngineError) return error;
    throw error;
  }
  throw new Error("Expected the invocation to fail.");
}

function gatewayEngine(gateway: ReturnType<typeof createGateway>) {
  return createEngine({
    name: "acme-gateway",
    version: "0.1.0",
    capabilities: gateway.capabilities,
  });
}

describe("createGateway with engine upstreams", () => {
  it("publishes the capabilities of several engines under one engine", () => {
    const gateway = createGateway({
      upstreams: [
        engineUpstream({ name: "support", engine: createSupportEngine() }),
        engineUpstream({
          name: "billing",
          engine: createBillingEngine(),
          namespace: "finance",
        }),
      ],
      rules: [{ match: "*", access: "authenticated" }],
    });
    const engine = gatewayEngine(gateway);

    expect(engine.list().map((summary) => summary.id)).toEqual([
      "support.classify-ticket",
      "support.close-ticket",
      "support.wait",
      "finance.billing.get-invoice",
      "finance.billing.refund",
    ]);
    const described = engine.describe("support.classify-ticket");
    expect(described).toMatchObject({
      title: "Classify ticket",
      description: "Classify a support ticket into an operational category.",
      annotations: { readOnly: true },
      access: "function",
    });
    expect(
      gateway.routes.find(
        (route) => route.capabilityId === "support.classify-ticket",
      )?.readOnly,
    ).toBe(true);
    expect(described.inputSchema).toMatchObject({
      type: "object",
      properties: { ticketId: { type: "string", minLength: 1 } },
      required: ["ticketId"],
    });
    expect(gateway.routes).toContainEqual({
      capabilityId: "finance.billing.refund",
      upstream: "billing",
      kind: "engine",
      upstreamCapabilityId: "billing.refund",
      readOnly: false,
      rule: "rules[0]",
    });
  });

  it("exposes only the included upstream capabilities", () => {
    const gateway = createGateway({
      upstreams: [
        engineUpstream({
          name: "support",
          engine: createSupportEngine(),
          include: ["support.classify-ticket"],
        }),
      ],
      rules: [{ match: "*", access: "public" }],
    });

    expect(gateway.routes.map((route) => route.capabilityId)).toEqual([
      "support.classify-ticket",
    ]);
  });

  it("denies every capability that no rule matches", async () => {
    const engine = gatewayEngine(
      createGateway({
        upstreams: [
          engineUpstream({ name: "billing", engine: createBillingEngine() }),
        ],
      }),
    );

    const anonymous = await failure(
      engine.invoke("billing.get-invoice", { invoiceId: "I-1" }),
    );
    const authenticated = await failure(
      engine.invoke(
        "billing.get-invoice",
        { invoiceId: "I-1" },
        { principal: agent },
      ),
    );

    expect(anonymous.code).toBe("UNAUTHENTICATED");
    expect(authenticated.code).toBe("FORBIDDEN");
  });

  it("applies the first matching rule", async () => {
    const engine = gatewayEngine(
      createGateway({
        upstreams: [
          engineUpstream({ name: "billing", engine: createBillingEngine() }),
          engineUpstream({ name: "support", engine: createSupportEngine() }),
        ],
        rules: [
          { name: "no-refunds", match: "billing.refund", access: "deny" },
          { name: "billing-read", match: "billing.*", access: "public" },
          {
            name: "support-read",
            match: "support.*",
            access: requireScopes("support:read"),
          },
        ],
      }),
    );

    await expect(
      engine.invoke("billing.get-invoice", { invoiceId: "I-1" }),
    ).resolves.toEqual({ invoiceId: "I-1", total: 42 });
    expect(
      (
        await failure(
          engine.invoke(
            "billing.refund",
            { invoiceId: "I-1" },
            { principal: agent },
          ),
        )
      ).code,
    ).toBe("FORBIDDEN");
    await expect(
      engine.invoke(
        "support.classify-ticket",
        { ticketId: "B-1" },
        { principal: viewer },
      ),
    ).resolves.toEqual({ category: "billing", principalId: "viewer-1" });
    expect(
      (
        await failure(
          engine.invoke(
            "support.classify-ticket",
            { ticketId: "B-1" },
            { principal: { id: "no-scopes" } },
          ),
        )
      ).code,
    ).toBe("FORBIDDEN");
  });

  it("keeps the upstream access rule enforced after the gateway allows", async () => {
    const engine = gatewayEngine(
      createGateway({
        upstreams: [
          engineUpstream({ name: "support", engine: createSupportEngine() }),
        ],
        rules: [{ match: "*", access: "public" }],
      }),
    );

    const anonymous = await failure(
      engine.invoke("support.classify-ticket", { ticketId: "A-1" }),
    );
    const notAnAgent = await failure(
      engine.invoke(
        "support.close-ticket",
        { ticketId: "T-1" },
        { principal: viewer },
      ),
    );

    expect(anonymous.code).toBe("UNAUTHENTICATED");
    expect(notAnAgent.code).toBe("FORBIDDEN");
  });

  it("maps the principal sent to an upstream engine", async () => {
    const engine = gatewayEngine(
      createGateway({
        upstreams: [
          engineUpstream({
            name: "support",
            engine: createSupportEngine(),
            principal: (principal, route) =>
              principal === null
                ? null
                : { id: `${route.upstream}:${principal.id}` },
          }),
        ],
        rules: [{ match: "*", access: "authenticated" }],
      }),
    );

    await expect(
      engine.invoke(
        "support.classify-ticket",
        { ticketId: "A-1" },
        { principal: viewer },
      ),
    ).resolves.toEqual({
      category: "general",
      principalId: "support:viewer-1",
    });
  });

  it("republishes upstream domain errors and framework failures", async () => {
    const engine = gatewayEngine(
      createGateway({
        upstreams: [
          engineUpstream({ name: "support", engine: createSupportEngine() }),
        ],
        rules: [{ match: "*", access: "authenticated" }],
      }),
    );

    expect(engine.describe("support.close-ticket").errors).toEqual([
      {
        code: "TICKET_ALREADY_CLOSED",
        description: "The ticket is already closed.",
        retryable: false,
        detailsSchema: expect.objectContaining({ type: "object" }),
      },
    ]);
    const domain = await failure(
      engine.invoke(
        "support.close-ticket",
        { ticketId: "T-closed" },
        { principal: agent },
      ),
    );
    expect(domain.code).toBe("DOMAIN_ERROR");
    expect(domain.message).toBe("The ticket is already closed.");
    expect(domain.publicDetails).toEqual({
      code: "TICKET_ALREADY_CLOSED",
      retryable: false,
      details: { ticketId: "T-closed" },
    });

    const invalid = await failure(
      engine.invoke(
        "support.classify-ticket",
        { ticketId: "" },
        { principal: agent },
      ),
    );
    expect(invalid.code).toBe("INPUT_INVALID");

    const notAnObject = await failure(
      engine.invoke("support.classify-ticket", [] as never, {
        principal: agent,
      }),
    );
    expect(notAnObject.code).toBe("INPUT_INVALID");
  });

  it("forwards progress and cancellation to the upstream engine", async () => {
    const engine = gatewayEngine(
      createGateway({
        upstreams: [
          engineUpstream({ name: "support", engine: createSupportEngine() }),
        ],
        rules: [{ match: "*", access: "public" }],
      }),
    );
    const progress = vi.fn();

    await engine.invoke(
      "support.classify-ticket",
      { ticketId: "A-1" },
      { principal: agent, onProgress: progress },
    );
    expect(progress).toHaveBeenCalledWith({ progress: 1, total: 2 });

    const controller = new AbortController();
    const pending = engine.invoke(
      "support.wait",
      {},
      { signal: controller.signal },
    );
    controller.abort();
    expect((await failure(pending)).code).toBe("CANCELLED");
  });

  it("reports each authorization decision without payloads", async () => {
    const decisions: GatewayDecision[] = [];
    const warn = vi.fn();
    const engine = createEngine({
      name: "audited-gateway",
      version: "0.1.0",
      logger: { debug() {}, info() {}, warn, error() {} },
      capabilities: createGateway({
        upstreams: [
          engineUpstream({ name: "billing", engine: createBillingEngine() }),
        ],
        rules: [
          { name: "read", match: "billing.get-invoice", access: "public" },
          {
            name: "broken-pdp",
            match: "billing.refund",
            access: () => {
              throw new Error("PDP unavailable");
            },
          },
        ],
        onDecision(decision) {
          decisions.push(decision);
          throw new Error("A failing audit sink must not change the result.");
        },
      }).capabilities,
    });

    await engine.invoke(
      "billing.get-invoice",
      { invoiceId: "I-1" },
      { requestId: "r-1" },
    );
    const denied = await failure(
      engine.invoke(
        "billing.refund",
        { invoiceId: "I-1" },
        { requestId: "r-2", principal: agent },
      ),
    );

    expect(denied.code).toBe("FORBIDDEN");
    expect(decisions).toEqual([
      {
        requestId: "r-1",
        capabilityId: "billing.get-invoice",
        upstream: "billing",
        rule: "read",
        outcome: "allowed",
      },
      {
        requestId: "r-2",
        capabilityId: "billing.refund",
        upstream: "billing",
        rule: "broken-pdp",
        outcome: "failed",
        principalId: "agent-1",
      },
    ]);
    expect(Object.isFrozen(decisions[0])).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      "Gateway access rule failed; access was denied.",
      { requestId: "r-2", capabilityId: "billing.refund", rule: "broken-pdp" },
    );
  });
});

describe("createGateway configuration", () => {
  it("rejects two upstreams that publish the same capability ID", () => {
    expect(() =>
      createGateway({
        upstreams: [
          engineUpstream({ name: "a", engine: createBillingEngine() }),
          engineUpstream({ name: "b", engine: createBillingEngine() }),
        ],
      }),
    ).toThrow(
      new TypeError(
        "Gateway capability billing.get-invoice is published by both a and b.",
      ),
    );
  });

  it("rejects duplicate upstream names", () => {
    expect(() =>
      createGateway({
        upstreams: [
          engineUpstream({ name: "a", engine: createBillingEngine() }),
          engineUpstream({
            name: "a",
            engine: createSupportEngine(),
          }),
        ],
      }),
    ).toThrow(new TypeError("Gateway upstream a is configured twice."));
  });

  it("rejects a rule or include pattern that matches nothing", () => {
    const upstream = engineUpstream({
      name: "billing",
      engine: createBillingEngine(),
    });
    expect(() =>
      createGateway({
        upstreams: [upstream],
        rules: [{ name: "typo", match: "biling.*", access: "deny" }],
      }),
    ).toThrow(
      new TypeError(
        "Gateway rule typo pattern biling.* matches no capability.",
      ),
    );
    expect(() =>
      createGateway({
        upstreams: [upstream],
        rules: [
          { name: "all", match: "*", access: "authenticated" },
          { name: "refunds", match: "billing.refund", access: "deny" },
        ],
      }),
    ).toThrow(
      new TypeError("Gateway rule refunds is shadowed by earlier rules."),
    );
    expect(() =>
      engineUpstream({
        name: "billing",
        engine: createBillingEngine(),
        include: ["billing.missing"],
      }),
    ).toThrow(
      new TypeError(
        "Upstream billing include pattern billing.missing matches no capability.",
      ),
    );
  });

  it.each(["", "billing*", "*.refund", "billing.*.x", ".*"])(
    "rejects the invalid pattern %j",
    (pattern) => {
      expect(() =>
        createGateway({
          upstreams: [
            engineUpstream({ name: "billing", engine: createBillingEngine() }),
          ],
          rules: [{ match: pattern, access: "public" }],
        }),
      ).toThrow(TypeError);
    },
  );

  it.each(["", "Upper", "with space", "a".repeat(65)])(
    "rejects the invalid upstream name %j",
    (name) => {
      expect(() =>
        engineUpstream({ name, engine: createBillingEngine() }),
      ).toThrow(TypeError);
    },
  );
});
