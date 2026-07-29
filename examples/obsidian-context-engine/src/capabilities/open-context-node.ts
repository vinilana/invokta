import { defineCapability } from "@ai-engine/core";
import { z } from "zod";

import type {
  ObsidianContextDependencies,
  OpenedVaultNode,
  VaultNodeLink,
  VaultNodeSummary,
} from "../application/ports.js";
import {
  graphDiagnostics,
  maximumContentCharacters,
  maximumOutgoingLinks,
  maximumRelatedIndexes,
  nodeId,
  nodeLink,
  nodeSummary,
  openedNode,
} from "./node-contract.js";

function cloneSummary(node: VaultNodeSummary) {
  return { ...node, frontmatter: structuredClone(node.frontmatter) };
}

function cloneNode(node: OpenedVaultNode | null) {
  return node === null
    ? null
    : { ...node, frontmatter: structuredClone(node.frontmatter) };
}

function cloneLink(link: VaultNodeLink) {
  return { ...link };
}

function cloneStrings(values: ReadonlyArray<string>): string[] {
  return Array.from(values);
}

export function createOpenContextNode({ graph }: ObsidianContextDependencies) {
  return defineCapability({
    title: "Open context node",
    description:
      "Open one knowledge node and return a bounded content page, its frontmatter, related indexes, and navigable outgoing links.",
    input: z.object({
      id: nodeId,
      contentOffset: z.number().int().min(0).default(0),
      maxContentCharacters: z
        .number()
        .int()
        .min(1)
        .max(maximumContentCharacters)
        .default(maximumContentCharacters),
    }),
    output: z.object({
      found: z.boolean(),
      node: openedNode.nullable(),
      relatedIndexes: z.array(nodeSummary).max(maximumRelatedIndexes),
      outgoingLinks: z.array(nodeLink).max(maximumOutgoingLinks),
      ...graphDiagnostics,
    }),
    access: "authenticated",
    timeoutMs: 15_000,
    annotations: {
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: false,
    },
    async run({ input, context }) {
      const result = await graph.openNode(
        {
          id: input.id,
          contentOffset: input.contentOffset,
          maxContentCharacters: input.maxContentCharacters,
          maxRelatedIndexes: maximumRelatedIndexes,
          maxOutgoingLinks: maximumOutgoingLinks,
        },
        { signal: context.signal },
      );
      return {
        found: result.found,
        node: cloneNode(result.node),
        relatedIndexes: result.relatedIndexes.map(cloneSummary),
        outgoingLinks: result.outgoingLinks.map(cloneLink),
        unresolvedLinks: cloneStrings(result.unresolvedLinks),
        unresolvedIndexes: cloneStrings(result.unresolvedIndexes),
        invalidNodeCount: result.invalidNodeCount,
        relationsTruncated: result.relationsTruncated,
      };
    },
  });
}
