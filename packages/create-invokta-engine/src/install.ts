import { spawn } from "node:child_process";

import { CreatorError } from "./errors.js";
import {
  isPackageManager,
  type PackageManager,
  packageManagerCommands,
} from "./package-manager.js";

export interface PackageManagerRunOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly shell: false;
  readonly stdio: "inherit";
}

export interface PackageManagerRunResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export type PackageManagerRunner = (
  options: PackageManagerRunOptions,
) => Promise<PackageManagerRunResult>;

export const defaultPackageManagerRunner: PackageManagerRunner = (options) =>
  new Promise((resolve, reject) => {
    const child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      shell: options.shell,
      stdio: options.stdio,
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });

export function selectPackageManager(
  explicit: PackageManager | undefined,
  userAgent: string | undefined,
): PackageManager {
  if (explicit !== undefined) return explicit;
  const candidate = userAgent?.split(/\s/u, 1)[0]?.split("/", 1)[0];
  return candidate !== undefined && isPackageManager(candidate)
    ? candidate
    : "npm";
}

export interface InstallProjectDependenciesOptions {
  readonly directory: string;
  readonly packageManager: PackageManager;
  readonly runner?: PackageManagerRunner;
}

/** Runs the one foreground package-manager install authorized by ADR 0012. */
export async function installProjectDependencies(
  options: InstallProjectDependenciesOptions,
): Promise<void> {
  const commands = packageManagerCommands[options.packageManager];
  let result: PackageManagerRunResult;
  try {
    result = await (options.runner ?? defaultPackageManagerRunner)({
      command: commands.installExecutable,
      args: commands.installArguments,
      cwd: options.directory,
      shell: false,
      stdio: "inherit",
    });
  } catch {
    throw new CreatorError("INSTALL_FAILED", [options.packageManager]);
  }
  if (result.code !== 0) {
    throw new CreatorError("INSTALL_FAILED", [options.packageManager]);
  }
}
