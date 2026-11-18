import type { Principal } from "@invokta/core";
import type { DiscoverySearchEvent } from "@invokta/gateway";
import {
  connectMcpClient,
  type McpClientConnection,
  type McpHttpServerHandle,
} from "@invokta/mcp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ToolNeedJudge } from "../src/application/ports.js";
import { startCrmMcpHttp } from "../src/crm-mcp-http.js";
import { createCrmGateway } from "../src/gateway.js";
import { createTypeSafeJevJudge } from "../src/infrastructure/typesafe-jev-judge.js";
import { createJevToolSelector } from "../src/selection/jev-tool-selector.js";
import { createFakeTypeSafeFetch } from "./support/fake-typesafe-api.js";

const serviceToken = "crm-service-token-for-tests";
const apiKey = "ts-test-key-0123456789";
const salesOps: Principal = {
  id: "sales-ops",
  attributes: { scopes: ["crm:read", "crm:write"] },
};
const salesReader: Principal = {
  id: "sales-reader",
  attributes: { scopes: ["crm:read"] },
};

let crmServer: McpHttpServerHandle;
let crm: McpClientConnection;

beforeEach(async () => {
  crmServer = await startCrmMcpHttp({ serviceToken, port: 0 });
  const { host, port } = crmServer.address();
  crm = await connectMcpClient({
    transport: "http",
    url: `http://${host}:${String(port)}/mcp`,
    authentication: { type: "bearer", token: serviceToken },
  });
});

afterEach(async () => {
  await crm.close();
  await crmServer.close();
});

function fakeJudge() {
  const fake = createFakeTypeSafeFetch({ apiKey });
  return {
    fake,
    judge: createTypeSafeJevJudge({ apiKey, fetch: fake.fetch }),
  };
}

async function searchIds(
  engine: Awaited<ReturnType<typeof createCrmGateway>>["discoveryEngine"],
  task: string,
  principal: Principal,
): Promise<string[]> {
  const result = (await engine.invoke(
    "gateway.search-tools",
    { query: task },
    { principal },
  )) as { tools: { id: string }[] };
  return result.tools.map((tool) => tool.id);
}

describe("createJevToolSelector", () => {
  it("keeps the tools above the threshold, most likely first", async () => {
    const judge: ToolNeedJudge = {
      async judge(_task, candidates) {
        return candidates.map((candidate, index) => ({
          id: candidate.id,
          probability: [0.2, 0.91, 0.55, 0.97][index] ?? 0,
        }));
      },
    };
    const selector = createJevToolSelector({ judge, threshold: 0.5 });
    const tools = ["a", "b", "c", "d"].map((id) => ({ id, description: id }));

    await expect(
      selector.select("task", tools, {
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual([
      { id: "d", probability: 0.97 },
      { id: "b", probability: 0.91 },
      { id: "c", probability: 0.55 },
    ]);
    expect(() => createJevToolSelector({ judge, threshold: 1 })).toThrow(
      TypeError,
    );
  });
});

describe("Jev in the gateway's discovery", () => {
  it("returns exactly the tools a multi-step task needs", async () => {
    const { judge, fake } = fakeJudge();
    const { discoveryEngine } = await createCrmGateway({
      crm,
      selector: createJevToolSelector({ judge }),
    });

    expect(
      await searchIds(
        discoveryEngine,
        "Cancel order O-42 and archive its invoice",
        salesOps,
      ),
    ).toEqual(["crm.billing_archive-invoice", "crm.orders_cancel-order"]);
    // 180 visible tools judged in batches of 16.
    expect(fake.requests).toHaveLength(12);
    expect(
      discoveryEngine.describe("gateway.search-tools").description,
    ).toContain("Describe the user's whole task in one sentence");
  });

  it("judges only the caller's visible tools and abstains when none is needed", async () => {
    const { judge, fake } = fakeJudge();
    const { discoveryEngine } = await createCrmGateway({
      crm,
      selector: createJevToolSelector({ judge }),
    });

    expect(
      await searchIds(discoveryEngine, "Cancel order O-42", salesReader),
    ).toEqual([]);
    const judged = fake.requests.flatMap((request) =>
      Object.values(
        request.body.questions as Record<
          string,
          { instructions: { tool: { id: string } } }
        >,
      ).map((question) => question.instructions.tool.id),
    );
    expect(judged).toHaveLength(80);
    expect(judged.some((id) => id.includes("_cancel-"))).toBe(false);

    expect(
      await searchIds(
        discoveryEngine,
        "What is the weather tomorrow?",
        salesOps,
      ),
    ).toEqual([]);
  });

  it("answers with lexical search when Jev is unavailable", async () => {
    const searches: DiscoverySearchEvent[] = [];
    const { discoveryEngine } = await createCrmGateway({
      crm,
      selector: createJevToolSelector({
        judge: createTypeSafeJevJudge({
          apiKey,
          fetch: createFakeTypeSafeFetch({ apiKey, status: 503 }).fetch,
        }),
      }),
      onSearch: (event) => {
        searches.push(event);
      },
    });

    expect(
      (await searchIds(discoveryEngine, "cancel order", salesOps))[0],
    ).toBe("crm.orders_cancel-order");
    expect(searches.map((event) => event.ranker)).toEqual(["lexical-fallback"]);
  });

  it("invokes the selected tools through the gateway rules", async () => {
    const { judge } = fakeJudge();
    const { discoveryEngine } = await createCrmGateway({
      crm,
      selector: createJevToolSelector({ judge }),
    });

    for (const tool of await searchIds(
      discoveryEngine,
      "Cancel order O-42 and archive its invoice",
      salesOps,
    )) {
      await expect(
        discoveryEngine.invoke(
          "gateway.invoke-tool",
          { tool, arguments: { id: "O-42" } },
          { principal: salesOps },
        ),
      ).resolves.toMatchObject({ result: { ok: true } });
    }
  });
});
