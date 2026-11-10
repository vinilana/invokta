import type { Principal } from "@invokta/core";
import type { DiscoverySearchEvent } from "@invokta/gateway";
import {
  connectMcpClient,
  type McpClientConnection,
  type McpHttpServerHandle,
} from "@invokta/mcp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startCrmMcpHttp } from "../src/crm-mcp-http.js";
import { createCrmGateway } from "../src/gateway.js";
import {
  createSemanticToolIndex,
  toolText,
} from "../src/search/semantic-tool-index.js";
import { createConceptEmbedder } from "./support/concept-embedder.js";

const serviceToken = "crm-service-token-for-tests";
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

type Built = Awaited<ReturnType<typeof createCrmGateway>>;

async function search(
  built: Built,
  query: string,
  principal: Principal,
  limit = 8,
): Promise<string[]> {
  const result = (await built.discoveryEngine.invoke(
    "gateway.search-tools",
    { query, limit },
    { principal },
  )) as { tools: { id: string }[] };
  return result.tools.map((tool) => tool.id);
}

const portugueseQueries: ReadonlyArray<readonly [string, string]> = [
  ["cancelar o pedido O-42", "crm.orders_cancel-order"],
  ["exportar o relatório do trimestre", "crm.analytics_export-report"],
  ["aprovar um contrato pendente", "crm.legal_approve-contract"],
  ["arquivar a campanha de verão", "crm.marketing_archive-campaign"],
  ["cadastrar um novo cliente", "crm.accounts_create-customer"],
  ["procurar chamados por palavra-chave", "crm.service_search-ticket"],
  ["atualizar os dados do fornecedor", "crm.procurement_update-vendor"],
  ["consultar a remessa 991", "crm.logistics_get-shipment"],
  ["listar as reuniões da semana", "crm.calendar_list-meeting"],
  ["exportar as faturas em CSV", "crm.billing_export-invoice"],
];

describe("semantic search in the gateway", () => {
  it("embeds every published tool once, at startup", async () => {
    const { embedder, calls } = createConceptEmbedder();
    const built = await createCrmGateway({
      crm,
      index: createSemanticToolIndex({ embedder }),
    });

    expect(built.indexed).toBe(200);
    expect(calls).toEqual([200]);
    await search(built, "cancelar o pedido", salesOps);
    // Each search embeds only its query.
    expect(calls).toEqual([200, 1]);
    expect(
      toolText({
        id: "crm.orders_cancel-order",
        description: "Cancel an order that has not completed.",
      }),
    ).toBe("crm order cancel order. Cancel an order that has not completed.");
  });

  it("finds tools from Portuguese sentences over English descriptions", async () => {
    const built = await createCrmGateway({
      crm,
      index: createSemanticToolIndex({
        embedder: createConceptEmbedder().embedder,
      }),
    });

    let found = 0;
    let first = 0;
    for (const [query, expected] of portugueseQueries) {
      const ids = await search(built, query, salesOps);
      if (ids.includes(expected)) found += 1;
      if (ids[0] === expected) first += 1;
    }
    expect(found / portugueseQueries.length).toBe(1);
    expect(first).toBe(portugueseQueries.length);
  });

  it("ranks only visible tools and returns nothing below the threshold", async () => {
    const built = await createCrmGateway({
      crm,
      index: createSemanticToolIndex({
        embedder: createConceptEmbedder().embedder,
      }),
    });

    const asReader = await search(
      built,
      "cancelar o pedido O-42",
      salesReader,
      20,
    );
    expect(asReader).not.toContain("crm.orders_cancel-order");
    expect(
      asReader.every((id) => !/_(?:cancel|delete|create)-/u.test(id)),
    ).toBe(true);
    expect(
      await search(built, "qual a previsão do tempo amanhã?", salesOps),
    ).toEqual([]);
  });

  it("answers with lexical search when the embeddings service fails", async () => {
    const searches: DiscoverySearchEvent[] = [];
    let failing = false;
    const { embedder } = createConceptEmbedder();
    const built = await createCrmGateway({
      crm,
      index: createSemanticToolIndex({
        embedder: {
          async embed(texts, options) {
            if (failing) throw new Error("embeddings service down");
            return embedder.embed(texts, options);
          },
        },
      }),
      onSearch: (event) => {
        searches.push(event);
      },
    });

    failing = true;
    expect((await search(built, "cancel order", salesOps))[0]).toBe(
      "crm.orders_cancel-order",
    );
    expect(searches.map((event) => event.ranker)).toEqual(["lexical-fallback"]);
  });

  it("refuses to serve when the catalog cannot be embedded", async () => {
    await expect(
      createCrmGateway({
        crm,
        index: createSemanticToolIndex({
          embedder: {
            async embed() {
              throw new Error("embeddings service down");
            },
          },
        }),
      }),
    ).rejects.toThrow("embeddings service down");
  });
});
