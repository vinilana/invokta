/** Internal filesystem boundary. It grows only when a delivery slice needs I/O. */
export interface InstallerFileSystem {
  readonly readFile: (path: URL) => Promise<Uint8Array>;
}
