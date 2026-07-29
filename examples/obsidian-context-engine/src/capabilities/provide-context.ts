import { defineCapability } from "@ai-engine/core";
import { z } from "zod";

import type { ObsidianContextDependencies } from "../application/ports.js";

const defaultMaxNotes = 5;
const maxContextCharacters = 20_000;

const query = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .regex(/[\p{Letter}\p{Number}]/u);

const relativeVaultPath = z
  .string()
  .min(1)
  .max(4_096)
  .regex(/^(?!\/)(?![A-Za-z]:)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\).+/u);

export function createProvideContext({ context }: ObsidianContextDependencies) {
  return defineCapability({
    title: "Provide Obsidian vault context",
    description:
      "Find relevant Markdown notes in a configured Obsidian vault and return bounded context with relative source paths.",
    input: z.object({
      query,
      maxNotes: z.number().int().min(1).max(10).default(defaultMaxNotes),
    }),
    output: z.object({
      query,
      context: z.string().max(maxContextCharacters),
      sources: z
        .array(
          z.object({
            path: relativeVaultPath,
            title: z.string().min(1).max(300),
          }),
        )
        .max(10),
      truncated: z.boolean(),
    }),
    access: "authenticated",
    timeoutMs: 15_000,
    annotations: {
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: false,
    },
    async run({ input, context: executionContext }) {
      const result = await context.provide(
        {
          query: input.query,
          maxNotes: input.maxNotes,
          maxContextCharacters,
        },
        { signal: executionContext.signal },
      );
      return {
        query: input.query,
        context: result.context,
        sources: result.sources.map((source) => ({ ...source })),
        truncated: result.truncated,
      };
    },
  });
}
