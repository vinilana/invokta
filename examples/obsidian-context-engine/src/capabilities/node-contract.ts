import { z } from "zod";

export const maximumRoots = 50;
export const maximumRelatedIndexes = 20;
export const maximumOutgoingLinks = 50;
export const maximumContentCharacters = 20_000;

export const nodeId = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u);

const relativeVaultPath = z
  .string()
  .min(1)
  .max(4_096)
  .regex(/^(?!\/)(?![A-Za-z]:)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\).+/u);

const frontmatter = z.record(z.string().min(1).max(100), z.json());

export const nodeSummary = z.object({
  id: nodeId,
  title: z.string().min(1).max(300),
  path: relativeVaultPath,
  frontmatter,
});

export const openedNode = nodeSummary.extend({
  content: z.string().max(maximumContentCharacters),
  contentOffset: z.number().int().min(0),
  contentLength: z.number().int().min(0),
  contentTruncated: z.boolean(),
});

export const nodeLink = z.object({
  reference: z.string().min(1).max(300),
  id: nodeId,
  title: z.string().min(1).max(300),
  path: relativeVaultPath,
});

export const graphDiagnostics = {
  unresolvedLinks: z
    .array(z.string().min(1).max(300))
    .max(maximumOutgoingLinks),
  unresolvedIndexes: z.array(nodeId).max(maximumRelatedIndexes),
  invalidNodeCount: z.number().int().min(0),
  relationsTruncated: z.boolean(),
} as const;
