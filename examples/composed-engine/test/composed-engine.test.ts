import { isComposedCapabilities } from "@invokta/core";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { capabilities } from "../src/capabilities.js";
import { createOperationsEngine, engine } from "../src/engine.js";
import { createDefaultOperationsDependencies } from "../src/infrastructure/default-dependencies.js";
import { localPrincipal as principal } from "../src/local-principal.js";

const effectiveIds = [
  "operations.generate-report",
  "community.score-ticket-priority",
  "operations.classify-ticket",
  "community.search-knowledge-base",
  "operations.draft-reply",
];

describe("the composed engine", () => {
  it("publishes exactly the effective IDs in composition order", () => {
    expect(engine.list().map((summary) => summary.id)).toEqual(effectiveIds);
    expect(Object.keys(capabilities)).toEqual(effectiveIds);
    expect(isComposedCapabilities(capabilities)).toBe(true);
    expect(Object.keys(JSON.parse(JSON.stringify(capabilities)))).toEqual(
      effectiveIds,
    );
  });

  it("removes remapped default IDs and unselected library capabilities", async () => {
    for (const removedId of [
      "community.classify-ticket",
      "community.draft-reply",
      "community.summarize-thread",
    ]) {
      expect(() =>
        // @ts-expect-error A removed default ID is not a typed capability ID.
        engine.describe(removedId),
      ).toThrowError(expect.objectContaining({ code: "CAPABILITY_NOT_FOUND" }));
    }

    await expect(
      engine.invoke(
        // @ts-expect-error The atomic `as` target replaced this default ID.
        "community.classify-ticket",
        { ticketId: "T-123" },
        { source: "direct", principal },
      ),
    ).rejects.toMatchObject({ code: "CAPABILITY_NOT_FOUND" });
    await expect(
      engine.invoke(
        // @ts-expect-error The library `remap` target replaced this default ID.
        "community.draft-reply",
        { ticketId: "T-123" },
        { source: "direct", principal },
      ),
    ).rejects.toMatchObject({ code: "CAPABILITY_NOT_FOUND" });
  });

  it("describes an imported capability under its effective ID without changing its contract", () => {
    const description = engine.describe("operations.classify-ticket");

    expect(description).toMatchObject({
      id: "operations.classify-ticket",
      title: "Classify ticket",
      description: "Classify a support ticket into an operational category.",
      timeoutMs: 30_000,
      annotations: {
        readOnly: true,
        destructive: false,
        idempotent: true,
        openWorld: false,
      },
    });
    expect(description.inputSchema).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { ticketId: { type: "string", minLength: 1 } },
      required: ["ticketId"],
    });
  });

  it("runs local, atomic, and library capabilities through the same invoke path", async () => {
    const report = await engine.invoke(
      "operations.generate-report",
      { day: "2026-07-27" },
      { source: "direct", principal },
    );
    const priority = await engine.invoke(
      "community.score-ticket-priority",
      { ticketId: "T-789" },
      { source: "direct", principal },
    );
    const classification = await engine.invoke(
      "operations.classify-ticket",
      { ticketId: "T-123" },
      { source: "direct", principal },
    );
    const articles = await engine.invoke(
      "community.search-knowledge-base",
      { query: "login" },
      { source: "direct", principal },
    );
    const reply = await engine.invoke(
      "operations.draft-reply",
      { ticketId: "T-123" },
      { source: "direct", principal },
    );

    expect(report).toEqual({
      day: "2026-07-27",
      openTickets: 3,
      resolvedTickets: 11,
      headline: "Billing questions dominated the queue.",
    });
    expect(priority).toEqual({
      priority: "urgent",
      weight: 8,
      signals: ["outage", "urgent", "blocked", "error"],
    });
    expect(classification).toEqual({
      category: "billing",
      confidence: 0.9,
      rationale: "The ticket contains language associated with billing.",
    });
    expect(articles).toEqual({
      articles: [
        {
          id: "KB-2",
          title: "Resetting a blocked login",
          url: "https://example.invalid/kb/login",
        },
      ],
    });
    expect(reply).toEqual({
      subject: "Re: Duplicate invoice",
      body: "Dear customer, We recommend these articles: Requesting a duplicate charge refund, Reading an invoice.",
      citedArticleIds: ["KB-1", "KB-3"],
    });

    expectTypeOf(classification).toEqualTypeOf<{
      category: "billing" | "technical" | "commercial" | "other";
      confidence: number;
      rationale: string;
    }>();
    expectTypeOf(reply).toEqualTypeOf<{
      subject: string;
      body: string;
      citedArticleIds: string[];
    }>();
  });

  it("keeps the effective ID as the only identity the access rule observes", async () => {
    const dependencies = createDefaultOperationsDependencies();
    const can = vi.fn(async () => true);
    const observed = createOperationsEngine({
      ...dependencies,
      community: { ...dependencies.community, permissions: { can } },
    });

    await observed.invoke(
      "operations.classify-ticket",
      { ticketId: "T-123" },
      { source: "direct", principal },
    );

    expect(can).toHaveBeenCalledExactlyOnceWith(
      principal,
      "ticket:classify",
      "T-123",
    );
  });

  it("builds an independent engine from injected ports", async () => {
    const dependencies = createDefaultOperationsDependencies();
    const custom = createOperationsEngine({
      ...dependencies,
      reports: {
        summarize: vi.fn(async (day: string) => ({
          day,
          openTickets: 42,
          resolvedTickets: 7,
          headline: "Injected report source.",
        })),
      },
    });

    await expect(
      custom.invoke(
        "operations.generate-report",
        { day: "2026-07-28" },
        { source: "direct", principal },
      ),
    ).resolves.toEqual({
      day: "2026-07-28",
      openTickets: 42,
      resolvedTickets: 7,
      headline: "Injected report source.",
    });
    await expect(
      engine.invoke(
        "operations.generate-report",
        { day: "2026-07-28" },
        { source: "direct", principal },
      ),
    ).resolves.toMatchObject({
      headline: "No operational activity was recorded.",
    });
  });
});
