import { EngineError, type Principal } from "@invokta/core";
import type { GatewayDecision } from "@invokta/gateway";
import {
  connectMcpClient,
  type McpClientConnection,
  type McpHttpServerHandle,
} from "@invokta/mcp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startDocsMcpHttp } from "../src/docs-mcp-http.js";
import { createAcmeGateway } from "../src/gateway.js";

const serviceToken = "docs-service-token-for-tests";
const supportAgent: Principal = {
  id: "support-agent",
  attributes: { scopes: ["support", "billing:read"], agent: true },
};
const financeBot: Principal = {
  id: "finance-bot",
  attributes: { scopes: ["billing:read", "billing:refund"] },
};
const reader: Principal = { id: "reader", attributes: { scopes: [] } };

let docsServer: McpHttpServerHandle;
let docs: McpClientConnection;

beforeEach(async () => {
  docsServer = await startDocsMcpHttp({ serviceToken, port: 0 });
  const { host, port } = docsServer.address();
  docs = await connectMcpClient({
    transport: "http",
    url: `http://${host}:${String(port)}/mcp`,
    authentication: { type: "bearer", token: serviceToken },
  });
});

afterEach(async () => {
  await docs.close();
  await docsServer.close();
});

async function failure(pending: Promise<unknown>): Promise<EngineError> {
  try {
    await pending;
  } catch (error) {
    if (error instanceof EngineError) return error;
    throw error;
  }
  throw new Error("Expected the invocation to fail.");
}

describe("Acme gateway", () => {
  it("publishes two local engines and one MCP server under one policy", async () => {
    const { gateway, engine } = await createAcmeGateway({ docs });

    expect(
      gateway.routes.map(({ capabilityId, upstream, rule, readOnly }) => ({
        capabilityId,
        upstream,
        rule,
        readOnly,
      })),
    ).toEqual([
      {
        capabilityId: "support.classify-ticket",
        upstream: "support",
        rule: "support",
        readOnly: true,
      },
      {
        capabilityId: "support.close-ticket",
        upstream: "support",
        rule: "support",
        readOnly: false,
      },
      {
        capabilityId: "billing.get-invoice",
        upstream: "billing",
        rule: "billing-read",
        readOnly: true,
      },
      {
        capabilityId: "billing.refund-invoice",
        upstream: "billing",
        rule: "refunds",
        readOnly: false,
      },
      {
        capabilityId: "kb.docs_search",
        upstream: "docs",
        rule: "knowledge-base",
        readOnly: true,
      },
    ]);
    expect(engine.describe("kb.docs_search")).toMatchObject({
      title: "Search the knowledge base",
      timeoutMs: 10_000,
    });
  });

  it("enforces the gateway rules and keeps each upstream's own rules", async () => {
    const decisions: GatewayDecision[] = [];
    const { engine } = await createAcmeGateway({
      docs,
      onDecision: (decision) => decisions.push(decision),
    });

    await expect(
      engine.invoke(
        "kb.docs_search",
        { query: "refund" },
        { principal: reader },
      ),
    ).resolves.toMatchObject({ articles: [{ slug: "refund-policy" }] });

    expect(
      (
        await failure(
          engine.invoke(
            "billing.refund-invoice",
            { invoiceId: "INV-1001" },
            { principal: supportAgent },
          ),
        )
      ).code,
    ).toBe("FORBIDDEN");
    await expect(
      engine.invoke(
        "billing.refund-invoice",
        { invoiceId: "INV-1001" },
        { principal: financeBot },
      ),
    ).resolves.toMatchObject({ refunded: true });

    // The gateway allows the support scope; the support engine still
    // requires an agent before closing a ticket.
    const notAnAgent = await failure(
      engine.invoke(
        "support.close-ticket",
        { ticketId: "T-1" },
        {
          principal: { id: "triage-bot", attributes: { scopes: ["support"] } },
        },
      ),
    );
    expect(notAnAgent.code).toBe("FORBIDDEN");

    expect(
      decisions.map(({ capabilityId, rule, outcome }) => ({
        capabilityId,
        rule,
        outcome,
      })),
    ).toEqual([
      {
        capabilityId: "kb.docs_search",
        rule: "knowledge-base",
        outcome: "allowed",
      },
      {
        capabilityId: "billing.refund-invoice",
        rule: "refunds",
        outcome: "denied",
      },
      {
        capabilityId: "billing.refund-invoice",
        rule: "refunds",
        outcome: "allowed",
      },
      {
        capabilityId: "support.close-ticket",
        rule: "support",
        outcome: "allowed",
      },
    ]);
  });

  it("republishes upstream domain errors unchanged", async () => {
    const { engine } = await createAcmeGateway({ docs });

    const refunded = await failure(
      engine.invoke(
        "billing.refund-invoice",
        { invoiceId: "INV-1002" },
        { principal: financeBot },
      ),
    );
    expect(refunded.code).toBe("DOMAIN_ERROR");
    expect(refunded.publicDetails).toEqual({
      code: "ALREADY_REFUNDED",
      retryable: false,
    });

    await engine.invoke(
      "support.close-ticket",
      { ticketId: "T-7" },
      { principal: supportAgent },
    );
    const closedTwice = await failure(
      engine.invoke(
        "support.close-ticket",
        { ticketId: "T-7" },
        { principal: supportAgent },
      ),
    );
    expect(closedTwice.publicDetails).toEqual({
      code: "TICKET_ALREADY_CLOSED",
      retryable: false,
      details: { ticketId: "T-7" },
    });
  });

  it("shows each caller only the capabilities its rules can allow", async () => {
    const { gateway } = await createAcmeGateway({ docs });
    const visible = (principal: Principal) =>
      gateway.routes
        .map((route) => route.capabilityId)
        .filter((capabilityId) =>
          gateway.visibility({ principal, capabilityId }),
        );

    expect(visible(reader)).toEqual(["kb.docs_search"]);
    expect(visible(supportAgent)).toEqual([
      "support.classify-ticket",
      "support.close-ticket",
      "billing.get-invoice",
      "kb.docs_search",
    ]);
    expect(visible(financeBot)).toEqual([
      "billing.get-invoice",
      "billing.refund-invoice",
      "kb.docs_search",
    ]);
  });

  it("refuses to start when the pinned docs catalog changed", async () => {
    const { docsFingerprint } = await createAcmeGateway({ docs });

    await expect(
      createAcmeGateway({ docs, docsCatalogPin: docsFingerprint }),
    ).resolves.toBeDefined();
    await expect(
      createAcmeGateway({ docs, docsCatalogPin: "0".repeat(64) }),
    ).rejects.toThrow(
      "MCP upstream docs tool catalog does not match the pinned fingerprint.",
    );
  });
});
