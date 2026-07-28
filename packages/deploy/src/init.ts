import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { DeployError, renderDeployDiagnostic } from "./errors.js";
import type { DeployContext, DeployExitCode } from "./io.js";
import { writeDiagnostic } from "./io.js";
import {
  type HttpDeployManifest,
  loadDeployManifest,
  toDeployError,
} from "./manifest.js";
import {
  createScaffoldFiles,
  type ScaffoldFile,
  starterDeployManifest,
} from "./scaffold/index.js";

// Nothing about a rejected argument is echoed, so a crafted argument can
// neither forge a diagnostic line nor reach a log.
const invalidUsageText = 'Invalid arguments. Run "ai-engine-deploy --help".\n';

type ScaffoldStatus = "created" | "skipped";

function readErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Resolves the manifest that parameterizes the scaffold. A project without one
 * is exactly what `init` is for; a rejected one fails before any file is
 * written, so a broken manifest never yields half a scaffold.
 */
async function resolveManifest(cwd: string): Promise<HttpDeployManifest> {
  const result = await loadDeployManifest({ cwd });
  if (result.ok) return result.manifest;
  if (result.code === "MANIFEST_NOT_FOUND") return starterDeployManifest;
  throw toDeployError(result);
}

async function writeScaffoldFile(
  cwd: string,
  file: ScaffoldFile,
): Promise<ScaffoldStatus> {
  const target = join(cwd, file.path);
  try {
    await mkdir(dirname(target), { recursive: true });
    // The exclusive flag never truncates: an existing target is reported and
    // left exactly as the author wrote it.
    await writeFile(target, file.contents, { encoding: "utf8", flag: "wx" });
    return "created";
  } catch (error) {
    if (readErrorCode(error) === "EEXIST") return "skipped";
    throw new DeployError("WRITE_FAILED", { details: [file.path] });
  }
}

/**
 * Scaffolds the deployment manifest, the production-shaped HTTP composition
 * root, its fail-closed authentication hook, the environment-file loader, and
 * the secret-free example file. An existing file is never overwritten: it is
 * reported as skipped and the command still succeeds.
 */
export async function runInit(
  args: readonly string[],
  context: DeployContext,
): Promise<DeployExitCode> {
  if (args.length > 0) {
    await writeDiagnostic(context, invalidUsageText);
    return 2;
  }

  try {
    const manifest = await resolveManifest(context.cwd);
    for (const file of createScaffoldFiles(manifest)) {
      const status = await writeScaffoldFile(context.cwd, file);
      await writeDiagnostic(context, `${status} ${file.path}\n`);
    }
    return 0;
  } catch (error) {
    if (!(error instanceof DeployError)) throw error;
    await writeDiagnostic(context, renderDeployDiagnostic(error));
    return error.exitCode;
  }
}
