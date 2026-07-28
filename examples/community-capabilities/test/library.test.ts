import {
  composeCapabilities,
  createEngine,
  importCapabilities,
  type Principal,
} from "@ai-engine/core";
import { describe, expect, it } from "vitest";

import type { CommunitySupportDependencies } from "../src/application/ports.js";
import { createCommunitySupportLibrary } from "../src/library.js";
import {
  createDependencies,
  createKnowledgeBase,
  createTicketRepository,
} from "./dependencies.js";

const principal: Principal = { id: "agent:library" };

function createEuropeanDependencies(): CommunitySupportDependencies {
  return createDependencies({
    knowledge: createKnowledgeBase([
      {
        id: "KB-EU-1",
        title: "Requesting a refund in the European Union",
        url: "https://example.invalid/eu/refunds",
      },
    ]),
    tickets: createTicketRepository([
      {
        id: "T-123",
        subject: "Duplicate invoice",
        body: "I was charged twice for the same invoice.",
      },
    ]),
  });
}

function createAmericanDependencies(): CommunitySupportDependencies {
  return createDependencies({
    knowledge: createKnowledgeBase([
      {
        id: "KB-US-1",
        title: "Requesting a refund in the United States",
        url: "https://example.invalid/us/refunds",
      },
    ]),
    tickets: createTicketRepository([
      {
        id: "T-123",
        subject: "Unexpected charge",
        body: "A second charge appeared on my card statement.",
      },
    ]),
  });
}

describe("one library factory reused by two engines", () => {
  it("keeps each engine bound to its own dependency implementations", async () => {
    const europeanDependencies = createEuropeanDependencies();
    const americanDependencies = createAmericanDependencies();
    const europeanEngine = createEngine({
      name: "eu-support-engine",
      version: "0.0.0-test",
      capabilities: composeCapabilities({
        imports: [
          importCapabilities(
            createCommunitySupportLibrary(europeanDependencies),
          ),
        ],
      }),
    });
    const americanEngine = createEngine({
      name: "us-support-engine",
      version: "0.0.0-test",
      capabilities: composeCapabilities({
        imports: [
          importCapabilities(
            createCommunitySupportLibrary(americanDependencies),
            {
              include: ["community.draft-reply"],
              remap: { "community.draft-reply": "us.draft-reply" },
            },
          ),
        ],
      }),
    });

    const european = await europeanEngine.invoke(
      "community.draft-reply",
      { ticketId: "T-123" },
      { source: "direct", principal },
    );
    const american = await americanEngine.invoke(
      "us.draft-reply",
      { ticketId: "T-123" },
      { source: "direct", principal },
    );

    expect(european).toEqual({
      subject: "Re: Duplicate invoice",
      body: "Dear customer, We recommend these articles: Requesting a refund in the European Union.",
      citedArticleIds: ["KB-EU-1"],
    });
    expect(american).toEqual({
      subject: "Re: Unexpected charge",
      body: "Dear customer, We recommend these articles: Requesting a refund in the United States.",
      citedArticleIds: ["KB-US-1"],
    });
    expect(european).not.toEqual(american);

    expect(europeanDependencies.knowledge.search).toHaveBeenCalledTimes(1);
    expect(americanDependencies.knowledge.search).toHaveBeenCalledTimes(1);
    expect(europeanDependencies.tickets.findById).toHaveBeenCalledTimes(1);
    expect(americanDependencies.tickets.findById).toHaveBeenCalledTimes(1);
  });

  it("lets each engine shape the same library without sharing framework state", () => {
    const europeanLibrary = createCommunitySupportLibrary(
      createEuropeanDependencies(),
    );
    const americanLibrary = createCommunitySupportLibrary(
      createAmericanDependencies(),
    );

    expect(europeanLibrary).not.toBe(americanLibrary);
    expect(europeanLibrary.capabilities["community.draft-reply"]).not.toBe(
      americanLibrary.capabilities["community.draft-reply"],
    );
    expect(Object.keys(europeanLibrary.capabilities)).toEqual(
      Object.keys(americanLibrary.capabilities),
    );

    const everything = composeCapabilities({
      imports: [importCapabilities(europeanLibrary)],
    });
    const subset = composeCapabilities({
      imports: [
        importCapabilities(americanLibrary, {
          include: ["community.search-knowledge-base"],
          remap: { "community.search-knowledge-base": "us.search-articles" },
        }),
      ],
    });

    expect(Object.keys(everything)).toEqual([
      "community.summarize-thread",
      "community.search-knowledge-base",
      "community.draft-reply",
    ]);
    expect(Object.keys(subset)).toEqual(["us.search-articles"]);
  });

  it("keeps the library map order regardless of the include order", () => {
    const library = createCommunitySupportLibrary(createEuropeanDependencies());

    const composed = composeCapabilities({
      imports: [
        importCapabilities(library, {
          include: ["community.draft-reply", "community.summarize-thread"],
          remap: { "community.draft-reply": "eu.draft-reply" },
        }),
      ],
    });

    expect(Object.keys(composed)).toEqual([
      "community.summarize-thread",
      "eu.draft-reply",
    ]);
  });
});
