import { runEngineInstallerCliWithDependencies } from "./engine-cli-internal.js";

export interface RunEngineInstallerCliOptions {
  /** Absolute directory holding the embedding engine's `invokta.mcp.json`. */
  readonly packageRoot: string;
  /** Executable name rendered in help and usage diagnostics. */
  readonly binaryName: string;
  readonly argv?: readonly string[];
}

export function runEngineInstallerCli(
  options: RunEngineInstallerCliOptions,
): Promise<0 | 1 | 2 | 130> {
  return runEngineInstallerCliWithDependencies({
    binaryName: options.binaryName,
    packageRoot: options.packageRoot,
    ...(options.argv === undefined ? {} : { argv: options.argv }),
  });
}
