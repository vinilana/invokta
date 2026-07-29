export type JsonValue =
  | null
  | string
  | number
  | boolean
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface VaultNodeSummary {
  readonly id: string;
  readonly title: string;
  readonly path: string;
  readonly frontmatter: Record<string, JsonValue>;
}

export interface OpenedVaultNode extends VaultNodeSummary {
  readonly content: string;
  readonly contentOffset: number;
  readonly contentLength: number;
  readonly contentTruncated: boolean;
}

export interface VaultNodeLink {
  readonly reference: string;
  readonly id: string;
  readonly title: string;
  readonly path: string;
}

export interface VaultRootsResult {
  readonly roots: ReadonlyArray<VaultNodeSummary>;
  readonly invalidNodeCount: number;
  readonly truncated: boolean;
}

export interface OpenVaultNodeResult {
  readonly found: boolean;
  readonly node: OpenedVaultNode | null;
  readonly relatedIndexes: ReadonlyArray<VaultNodeSummary>;
  readonly outgoingLinks: ReadonlyArray<VaultNodeLink>;
  readonly unresolvedLinks: ReadonlyArray<string>;
  readonly unresolvedIndexes: ReadonlyArray<string>;
  readonly invalidNodeCount: number;
  readonly relationsTruncated: boolean;
}

export interface VaultKnowledgeGraph {
  listRoots(
    request: { readonly maxRoots: number },
    options: { readonly signal: AbortSignal },
  ): Promise<VaultRootsResult>;
  openNode(
    request: {
      readonly id: string;
      readonly contentOffset: number;
      readonly maxContentCharacters: number;
      readonly maxRelatedIndexes: number;
      readonly maxOutgoingLinks: number;
    },
    options: { readonly signal: AbortSignal },
  ): Promise<OpenVaultNodeResult>;
}

export interface ObsidianContextDependencies {
  readonly graph: VaultKnowledgeGraph;
}
