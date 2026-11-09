import { describe, expect, it } from "vitest";

import { createSearchIndex, tokenize } from "../src/search-index.js";

describe("tokenize", () => {
  it("splits IDs, separators, and camelCase, lowercases, and folds diacritics", () => {
    expect(tokenize("billing.refund-invoice")).toEqual([
      "billing",
      "refund",
      "invoice",
    ]);
    expect(tokenize("fetch_pageContent")).toEqual(["fetch", "page", "content"]);
    expect(tokenize("Cobrança  RELATÓRIO, ação!")).toEqual([
      "cobranca",
      "relatorio",
      "acao",
    ]);
  });

  it("folds regular plurals to the singular for the catalog and the query", () => {
    for (const [plural, single] of <const>[
      ["tickets", "ticket"],
      ["addresses", "address"],
      ["matches", "match"],
      ["boxes", "box"],
      ["categories", "category"],
      ["pedidos", "pedido"],
    ]) {
      expect(tokenize(plural)).toEqual(tokenize(single));
    }
    expect(tokenize("status class bus v2s")).toEqual([
      "status",
      "class",
      "bus",
      "v2s",
    ]);
  });
});

describe("createSearchIndex", () => {
  const index = createSearchIndex([
    {
      id: "billing.refund-invoice",
      title: "Refund invoice",
      description: "Return the money of one paid invoice.",
    },
    {
      id: "billing.get-invoice",
      description: "Return one invoice by its identifier.",
    },
    {
      id: "support.close-ticket",
      description: "Close a ticket after a refund was issued.",
    },
    { id: "hr.list-employees", description: "List employees." },
  ]);
  const everyone = new Set([
    "billing.refund-invoice",
    "billing.get-invoice",
    "support.close-ticket",
    "hr.list-employees",
  ]);

  it("ranks ID and title matches above description matches", () => {
    expect(index.search("refund", everyone)).toEqual([
      "billing.refund-invoice",
      "support.close-ticket",
    ]);
  });

  it("returns only candidates in the given set and drops non-matches", () => {
    expect(
      index.search(
        "refund invoice",
        new Set(["support.close-ticket", "billing.get-invoice"]),
      ),
    ).toEqual(["billing.get-invoice", "support.close-ticket"]);
    expect(index.search("payroll", everyone)).toEqual([]);
  });

  it("is deterministic and breaks ties by capability ID", () => {
    const first = index.search("invoice", everyone);
    expect(index.search("invoice", everyone)).toEqual(first);
    expect(first.slice(0, 2).sort()).toEqual([
      "billing.get-invoice",
      "billing.refund-invoice",
    ]);
  });
});
