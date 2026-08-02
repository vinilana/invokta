import { randomBytes } from "node:crypto";
import type {
  InstallerFileSystem,
  InstallerTransactionFileSystem,
  MutationCoordinatorDependencies,
} from "@invokta/installer-core";
import {
  configurationTargetAdapters,
  createNodeExecutableResolver,
  createNodeFileSystem,
  createNodeTargetConfigEvidenceProbes,
  createProcessInstallerEnvironment,
  createRemoteInstallDescriptor,
  detectHarnesses,
  type ExecutableResolver,
  type InstallerEnvironment,
  InstallerError,
  loadBundledRegistry,
  loadEngineInstallManifest,
  loadEngineRemovalManifest,
  type OperatingSystemHomeResolver,
  type PathSafetyContract,
  type RegistryCompatibilityAdapters,
  registryCompatibilityAdapters,
  resolveNodeOperatingSystemHome,
  resolvePathSafetyContract,
  type TargetConfigEvidenceProbes,
} from "@invokta/installer-core";
import { createClackInteractivePrompter } from "./clack-interactive-prompter.js";
import { runEngineRemovalSession } from "./engine-removal-session.js";
import { runInstallSession } from "./install-session.js";
import type { InteractivePrompter } from "./interactive-prompter.js";
import { runManagementSession } from "./management-session.js";
import { runReadOnlyInventory } from "./read-only-inventory.js";
import type {
  InstallerCommand,
  InstallerExitCode,
} from "./run-installer-cli.js";

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
  contract: PathSafetyContract,
): MutationCoordinatorDependencies {
  return {
    adapters: configurationTargetAdapters,
    contract,
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
  const contract = resolvePathSafetyContract({
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    currentUserId,
  });
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
          contract,
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
          contract,
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
          contract,
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
