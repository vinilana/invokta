import { randomBytes } from "node:crypto";

import { createClackInteractivePrompter } from "./clack-interactive-prompter.js";
import {
  loadEngineInstallManifest,
  loadEngineRemovalManifest,
} from "./engine-manifest.js";
import { runEngineRemovalSession } from "./engine-removal-session.js";
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
import { runManagementSession } from "./management-session.js";
import type { MutationCoordinatorDependencies } from "./mutation-coordinator.js";
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
import { createRemoteInstallDescriptor } from "./remote-install-source.js";
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
  readonly platform?: NodeJS.Platform;
}

function mutationDependencies(
  currentUserId: number,
  environment: InstallerEnvironment,
  fileSystem: InstallerTransactionFileSystem,
): MutationCoordinatorDependencies {
  return {
    adapters: configurationTargetAdapters,
    currentUserId,
    environment,
    fileSystem,
    lock: {
      clock: {
        monotonicNow: () => performance.now(),
        now: () => Date.now(),
        wait: (milliseconds) =>
          new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)),
      },
      processId: process.pid,
      randomBytes: (length) => randomBytes(length),
    },
    now: () => new Date().toISOString(),
  };
}

export async function runInteractiveSession(
  options: RunInteractiveSessionOptions = {},
): Promise<InstallerExitCode> {
  const prompter = options.prompter ?? createClackInteractivePrompter();
  prompter.intro("Invokta capability installer");
  const command = options.command ?? { kind: "inventory" as const };
  const nodeFileSystem = createNodeFileSystem();
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const transactionFileSystem = options.transactionFileSystem ?? nodeFileSystem;
  const currentUserId = process.getuid?.() ?? -1;
  const removalSource =
    command.kind === "remove-engine"
      ? await loadEngineRemovalManifest({
          currentUserId,
          fileSystem: transactionFileSystem,
          projectDirectory: command.projectDirectory,
        })
      : undefined;
  const progress = prompter.spinner();
  progress.start("Detecting supported AI harnesses");
  let detectionComplete = false;
  try {
    const registry =
      command.kind === "inventory" ||
      command.kind === "status" ||
      command.kind === "enable" ||
      command.kind === "disable" ||
      command.kind === "remove"
        ? await loadBundledRegistry(
            fileSystem,
            options.compatibilityAdapters ?? registryCompatibilityAdapters,
          )
        : undefined;
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
          ...(options.platform === undefined
            ? {}
            : { platform: options.platform }),
        }),
    });
    progress.stop("Harness detection complete");
    detectionComplete = true;
    if (command.kind === "inventory") {
      return await runReadOnlyInventory(snapshot, prompter);
    }
    if (command.kind === "remove-engine" && removalSource !== undefined) {
      return await runEngineRemovalSession({
        dependencies: mutationDependencies(
          currentUserId,
          environment,
          transactionFileSystem,
        ),
        prompter,
        snapshot,
        source: removalSource,
      });
    }
    if (command.kind === "install-engine" || command.kind === "install-http") {
      const descriptor =
        command.kind === "install-engine"
          ? (
              await loadEngineInstallManifest({
                currentUserId,
                fileSystem: transactionFileSystem,
                nodeExecutable: process.execPath,
                projectDirectory: command.projectDirectory,
              })
            ).descriptor
          : createRemoteInstallDescriptor(command);
      return await runInstallSession({
        dependencies: mutationDependencies(
          currentUserId,
          environment,
          transactionFileSystem,
        ),
        descriptor,
        prompter,
        resolveExecutable,
        snapshot,
      });
    }
    if (
      (command.kind === "status" ||
        command.kind === "enable" ||
        command.kind === "disable" ||
        command.kind === "remove") &&
      registry !== undefined
    ) {
      return await runManagementSession({
        action: command.kind,
        dependencies: mutationDependencies(
          currentUserId,
          environment,
          transactionFileSystem,
        ),
        prompter,
        registry,
        resolveExecutable,
        snapshot,
      });
    }
    throw new InstallerError("INSTALLER_INITIALIZATION_FAILED");
  } catch (error) {
    if (!detectionComplete) progress.error("Harness detection failed");
    throw error;
  }
}
