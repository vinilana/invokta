import { defineCapability } from "@invokta/core";
import { z } from "zod";

import type { ObsidianContextDependencies } from "../application/ports.js";
import { maximumRoots, nodeSummary } from "./node-contract.js";

export function createListContextRoots({ graph }: ObsidianContextDependencies) {
  return defineCapability({
    title: "List context roots",
    description:
      "List the explicitly declared entrypoint indexes available for progressive knowledge navigation.",
    input: z.object({}).strict(),
    output: z.object({
      roots: z.array(nodeSummary).max(maximumRoots),
      invalidNodeCount: z.number().int().min(0),
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
    async run({ context }) {
      const result = await graph.listRoots(
        { maxRoots: maximumRoots },
        { signal: context.signal },
      );
      return {
        roots: result.roots.map((root) => ({
          ...root,
          frontmatter: structuredClone(root.frontmatter),
        })),
        invalidNodeCount: result.invalidNodeCount,
        truncated: result.truncated,
      };
    },
  });
}
