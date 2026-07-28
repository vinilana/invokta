import { defineCapability } from "@ai-engine/core";
import { z } from "zod";

import type { CommunityLibraryDependencies } from "../application/ports.js";

const input = z.object({
  query: z.string().trim().min(1),
  limit: z.number().int().min(1).max(10).default(3),
});

const output = z.object({
  articles: z.array(
    z.object({
      id: z.string().min(1),
      title: z.string().min(1),
      url: z.string().min(1),
    }),
  ),
});

export function createSearchKnowledgeBase({
  knowledge,
  permissions,
}: CommunityLibraryDependencies) {
  return defineCapability({
    title: "Search knowledge base",
    description: "Search the support knowledge base for relevant articles.",
    input,
    output,
    access: async ({ principal, input: authorizedInput }) => {
      if (principal === null) return false;
      return permissions.can(
        principal,
        "knowledge:search",
        authorizedInput.query,
      );
    },
    timeoutMs: 15_000,
    annotations: {
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: false,
    },
    async run({ input: executionInput, context }) {
      const articles = await knowledge.search(executionInput.query, {
        signal: context.signal,
      });
      return { articles: articles.slice(0, executionInput.limit) };
    },
  });
}
