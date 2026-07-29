import { randomBytes } from "node:crypto";

import { createClackInteractivePrompter } from "./clack-interactive-prompter.js";
import { loadEngineInstallManifest } from "./engine-manifest.js";
import type {
  InstallerFileSystem,
  InstallerTransactionFileSystem,
} from "./file-system.js";
import {
  detectHarnesses,
  type ExecutableResolver,
  type OperatingSystemHomeResolver,
  type TargetConfigEvidenceProbes,
} from "./harness-detection.js";
import { runInstallSession } from "./install-session.js";
import { InstallerError } from "./installer-error.js";
import type { InteractivePrompter } from "./interactive-prompter.js";
import { createNodeFileSystem } from "./node-file-system.js";
import {
  createNodeExecutableResolver,
  resolveNodeOperatingSystemHome,
} from "./node-harness-environment.js";
import { runReadOnlyInventory } from "./read-only-inventory.js";
import {
  loadBundledRegistry,
  type RegistryCompatibilityAdapters,
} from "./registry.js";
import type {
  InstallerCommand,
  InstallerExitCode,
} from "./run-installer-cli.js";
import {
  configurationTargetAdapters,
  registryCompatibilityAdapters,
} from "./target-adapters.js";
import {
  createNodeTargetConfigEvidenceProbes,
  createProcessInstallerEnvironment,
  type InstallerEnvironment,
} from "./target-config-evidence.js";

export interface RunInteractiveSessionOptions {
  readonly command?: InstallerCommand;
  readonly prompter?: InteractivePrompter;
  readonly fileSystem?: InstallerFileSystem;
  readonly transactionFileSystem?: InstallerTransactionFileSystem;
  readonly compatibilityAdapters?: RegistryCompatibilityAdapters;
  readonly resolveHomeDirectory?: OperatingSystemHomeResolver;
  readonly resolveExecutable?: ExecutableResolver;
  readonly configEvidenceProbes?: TargetConfigEvidenceProbes;
  readonly environment?: InstallerEnvironment;
}

export async function runInteractiveSession(
  options: RunInteractiveSessionOptions = {},
): Promise<InstallerExitCode> {
  const prompter = options.prompter ?? createClackInteractivePrompter();
  prompter.intro("Invokta capability installer");
  const progress = prompter.spinner();
  progress.start("Detecting supported AI harnesses");
  try {
    const command = options.command ?? { kind: "inventory" as const };
    const nodeFileSystem = createNodeFileSystem();
    const fileSystem = options.fileSystem ?? nodeFileSystem;
    if (command.kind === "inventory") {
      await loadBundledRegistry(
        fileSystem,
        options.compatibilityAdapters ?? registryCompatibilityAdapters,
      );
    }
    const environment =
      options.environment ?? createProcessInstallerEnvironment();
    const resolveExecutable =
      options.resolveExecutable ?? createNodeExecutableResolver();
    const snapshot = await detectHarnesses({
      resolveHomeDirectory:
        options.resolveHomeDirectory ?? resolveNodeOperatingSystemHome,
      resolveExecutable,
      configEvidenceProbes:
        options.configEvidenceProbes ??
        createNodeTargetConfigEvidenceProbes({
          environment,
          fileSystem,
        }),
    });
    progress.stop("Harness detection complete");
    if (command.kind === "inventory") {
      return await runReadOnlyInventory(snapshot, prompter);
    }
    if (command.kind === "install-engine") {
      const transactionFileSystem =
        options.transactionFileSystem ?? nodeFileSystem;
      const source = await loadEngineInstallManifest({
        currentUserId: process.getuid?.() ?? -1,
        fileSystem: transactionFileSystem,
        nodeExecutable: process.execPath,
        projectDirectory: command.projectDirectory,
      });
      return await runInstallSession({
        dependencies: {
          adapters: configurationTargetAdapters,
          currentUserId: process.getuid?.() ?? -1,
          environment,
          fileSystem: transactionFileSystem,
          lock: {
            clock: {
              monotonicNow: () => performance.now(),
              now: () => Date.now(),
              wait: (milliseconds) =>
                new Promise((resolveWait) =>
                  setTimeout(resolveWait, milliseconds),
                ),
            },
            processId: process.pid,
            randomBytes: (length) => randomBytes(length),
          },
          now: () => new Date().toISOString(),
        },
        descriptor: source.descriptor,
        prompter,
        resolveExecutable,
        snapshot,
      });
    }
    throw new InstallerError("INSTALLER_INITIALIZATION_FAILED");
  } catch (error) {
    progress.error("Harness detection failed");
    throw error;
  }
}
