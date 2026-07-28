export type InstallerPathInspection =
  | { readonly kind: "missing" }
  | {
      readonly kind: "regular-file" | "directory";
      readonly ownerId: number;
      readonly realPath: string;
    }
  | {
      readonly kind: "symbolic-link" | "other";
      readonly ownerId: number;
    };

/** Internal filesystem boundary. It grows only when a delivery slice needs I/O. */
export interface InstallerFileSystem {
  readonly readFile: (path: URL) => Promise<Uint8Array>;
  readonly inspectPath: (path: string) => Promise<InstallerPathInspection>;
}
