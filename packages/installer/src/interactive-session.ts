import { createClackInteractivePrompter } from "./clack-interactive-prompter.js";
import type { InstallerFileSystem } from "./file-system.js";
import {
  detectHarnesses,
  type ExecutableResolver,
  type OperatingSystemHomeResolver,
  type TargetConfigEvidenceProbes,
} from "./harness-detection.js";
import type { InteractivePrompter } from "./interactive-prompter.js";
import {
  createNodeExecutableResolver,
  resolveNodeOperatingSystemHome,
} from "./node-harness-environment.js";
import { createNodeFileSystem } from "./node-file-system.js";
import { runReadOnlyInventory } from "./read-only-inventory.js";
import {
  configurationTargetIds,
  loadBundledRegistry,
  type RegistryCompatibilityAdapters,
} from "./registry.js";
import type { InstallerExitCode } from "./run-installer-cli.js";
import {
  createNodeTargetConfigEvidenceProbes,
  createProcessInstallerEnvironment,
  type InstallerEnvironment,
} from "./target-config-evidence.js";

export interface RunInteractiveSessionOptions {
  readonly prompter?: InteractivePrompter;
  readonly fileSystem?: InstallerFileSystem;
  readonly compatibilityAdapters?: RegistryCompatibilityAdapters;
  readonly resolveHomeDirectory?: OperatingSystemHomeResolver;
  readonly resolveExecutable?: ExecutableResolver;
  readonly configEvidenceProbes?: TargetConfigEvidenceProbes;
  readonly environment?: InstallerEnvironment;
}

function developmentCompatibilityAdapters(): RegistryCompatibilityAdapters {
  return Object.freeze(
    Object.fromEntries(
      configurationTargetIds.map((targetId) => [
        targetId,
        () =>
          ({
            supported: false,
            reason: "target-adapter-not-implemented",
          }) as const,
      ]),
    ) as unknown as RegistryCompatibilityAdapters,
  );
}

export async function runInteractiveSession(
  options: RunInteractiveSessionOptions = {},
): Promise<InstallerExitCode> {
  const prompter = options.prompter ?? createClackInteractivePrompter();
  prompter.intro("AI Engine capability installer");
  const progress = prompter.spinner();
  progress.start("Detecting supported AI harnesses");
  try {
    const fileSystem = options.fileSystem ?? createNodeFileSystem();
    await loadBundledRegistry(
      fileSystem,
      options.compatibilityAdapters ?? developmentCompatibilityAdapters(),
    );
    const snapshot = await detectHarnesses({
      resolveHomeDirectory:
        options.resolveHomeDirectory ?? resolveNodeOperatingSystemHome,
      resolveExecutable:
        options.resolveExecutable ?? createNodeExecutableResolver(),
      configEvidenceProbes:
        options.configEvidenceProbes ??
        createNodeTargetConfigEvidenceProbes({
          environment:
            options.environment ?? createProcessInstallerEnvironment(),
          fileSystem,
        }),
    });
    progress.stop("Harness detection complete");
    return await runReadOnlyInventory(snapshot, prompter);
  } catch (error) {
    progress.error("Harness detection failed");
    throw error;
  }
}
