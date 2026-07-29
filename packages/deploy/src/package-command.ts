import { stat } from "node:fs/promises";
import { join } from "node:path";

import { DeployError, renderDeployDiagnostic } from "./errors.js";
import { entryFileSystemPath, entryPosixPath } from "./generate/entry.js";
import {
  type PackageManagerStrategy,
  selectPackageManager,
  supportedLockfileNames,
} from "./generate/lockfile.js";
import { type GeneratedFile, planGeneratedFiles } from "./generate/plan.js";
import { readProjectPackage } from "./generate/project-package.js";
import { applyGeneratedFile } from "./generate/write.js";
import type { DeployContext, DeployExitCode } from "./io.js";
import { writeDiagnostic } from "./io.js";
import { loadDeployManifest, toDeployError } from "./manifest.js";

// Mirrors the CLI wording: a rejected argument is never echoed, so a crafted
// argument can neither forge a diagnostic line nor reach a log.
const invalidUsageText = 'Invalid arguments. Run "invokta-deploy --help".\n';

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function detectPackageManager(
  cwd: string,
): Promise<PackageManagerStrategy> {
  const present: string[] = [];
  for (const lockfile of supportedLockfileNames) {
    if (await isRegularFile(join(cwd, lockfile))) present.push(lockfile);
  }
  return selectPackageManager(present);
}

/**
 * Generates the deterministic deployment package for the project in the
 * context's working directory. Validation runs before any write, every write
 * is atomic and governed by the generated-file marker, and nothing is ever
 * written to `stdout`.
 */
export async function runPackage(
  args: readonly string[],
  context: DeployContext,
): Promise<DeployExitCode> {
  if (args.length > 0) {
    await writeDiagnostic(context, invalidUsageText);
    return 2;
  }

  try {
    const manifestResult = await loadDeployManifest({ cwd: context.cwd });
    if (!manifestResult.ok) throw toDeployError(manifestResult);
    const manifest = manifestResult.manifest;

    const project = await readProjectPackage(context.cwd);
    const packageManager = await detectPackageManager(context.cwd);

    // Evidence that the author has built the project; the content of the entry
    // module is never inspected.
    const entry = entryFileSystemPath(context.cwd, manifest.entry);
    if (!(await isRegularFile(entry))) {
      throw new DeployError("ENTRY_NOT_BUILT", {
        details: [entryPosixPath(manifest.entry)],
      });
    }

    const conflicts: GeneratedFile[] = [];
    for (const file of planGeneratedFiles({
      manifest,
      packageManager,
      project,
    })) {
      const status = await applyGeneratedFile(context.cwd, file);
      if (status === "conflict") conflicts.push(file);
      await writeDiagnostic(context, `${status} ${file.path}\n`);
    }
    if (conflicts.length > 0) {
      throw new DeployError("GENERATED_FILE_CONFLICT", {
        details: conflicts.map(
          (file) => `${file.path}: the first line must be ${file.markerLine}`,
        ),
      });
    }
    return 0;
  } catch (error) {
    if (error instanceof DeployError) {
      await writeDiagnostic(context, renderDeployDiagnostic(error));
      return error.exitCode;
    }
    throw error;
  }
}
