export interface VaultContextSource {
  readonly path: string;
  readonly title: string;
}

export interface VaultContextResult {
  readonly context: string;
  readonly sources: ReadonlyArray<VaultContextSource>;
  readonly truncated: boolean;
}

export interface VaultContextProvider {
  provide(
    request: {
      readonly query: string;
      readonly maxNotes: number;
      readonly maxContextCharacters: number;
    },
    options: { readonly signal: AbortSignal },
  ): Promise<VaultContextResult>;
}

export interface ObsidianContextDependencies {
  readonly context: VaultContextProvider;
}
