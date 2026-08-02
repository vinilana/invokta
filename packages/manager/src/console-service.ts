/**
 * Everything the console can do, expressed without HTTP.
 *
 * The service owns the detection snapshot, the discovery roots, and the one
 * mutation slot. It performs no confirmation of its own: the page confirms, the
 * transport authorizes, and this layer executes through the core's transaction
 * coordinator so the terminal and the console share exactly one writer.
 */

import { randomBytes } from "node:crypto";

import {
  buildEngineInventory,
  type CapabilityInstallDescriptor,
  type ConfigurationTargetId,
  configurationTargetAdapters,
  createNodeExecutableResolver,
  createNodeFileSystem,
  createNodeTargetConfigEvidenceProbes,
  createProcessInstallerEnvironment,
  detectHarnesses,
  discoverEngineProjects,
  type EngineInventory,
  type EngineInventoryRow,
  type ExecutableResolver,
  type HarnessDetectionSnapshot,
  type InstallerDirectoryReader,
  type InstallerEnvironment,
  InstallerError,
  type InstallerTransactionFileSystem,
  installerErrorMessages,
  loadBundledRegistry,
  loadEngineInstallManifest,
  type MutationCoordinatorDependencies,
  managedDescriptorFor,
  mutateDescriptorAcrossTargets,
  type PathSafetyContract,
  persistedInstallDescriptorFor,
  registryCompatibilityAdapters,
  resolveNodeOperatingSystemHome,
  resolvePathSafetyContract,
  type TargetMutationResult,
  type ValidatedRegistry,
} from "@invokta/installer-core";

export type ConsoleAction = "install" | "enable" | "disable" | "remove";

export const consoleActions: readonly ConsoleAction[] = Object.freeze([
  "install",
  "enable",
  "disable",
  "remove",
]);

export interface ConsoleActionRequest {
  readonly action: ConsoleAction;
  readonly engineId: string;
  readonly targetIds: readonly ConfigurationTargetId[];
}

export interface ConsoleActionOutcome {
  readonly targetId: ConfigurationTargetId;
  readonly displayName: string;
  readonly outcome: TargetMutationResult["outcome"];
  readonly reloadHint?: string;
  readonly code?: string;
  readonly message?: string;
}

export type ConsoleActionResult =
  | {
      readonly kind: "applied";
      readonly results: readonly ConsoleActionOutcome[];
    }
  | {
      readonly kind: "rejected";
      readonly code: string;
      readonly message: string;
    }
  | { readonly kind: "busy" };

export interface ConsoleDiscoveryReport {
  readonly roots: readonly string[];
  readonly inspectedDirectories: number;
  readonly truncated: boolean;
  readonly rejected: readonly {
    readonly path: string;
    readonly code: string;
  }[];
}

export interface ConsoleInventory {
  readonly inventory: EngineInventory;
  readonly discovery: ConsoleDiscoveryReport;
  readonly homeDirectory: string;
  readonly nodeExecutable: string;
}

export interface ConsoleServiceOptions {
  readonly scanRoots: readonly string[];
  readonly fileSystem?: InstallerTransactionFileSystem &
    InstallerDirectoryReader;
  readonly environment?: InstallerEnvironment;
  readonly resolveExecutable?: ExecutableResolver;
  readonly resolveHomeDirectory?: () => string;
  readonly nodeExecutable?: string;
  readonly platform?: NodeJS.Platform;
}

export interface ConsoleService {
  readonly read: (options?: {
    readonly refresh?: boolean;
  }) => Promise<ConsoleInventory>;
  readonly apply: (
    request: ConsoleActionRequest,
  ) => Promise<ConsoleActionResult>;
}

function dependenciesFor(
  fileSystem: InstallerTransactionFileSystem,
  environment: InstallerEnvironment,
  contract: PathSafetyContract,
): MutationCoordinatorDependencies {
  return {
    adapters: configurationTargetAdapters,
    contract,
    currentUserId: process.getuid?.() ?? -1,
    environment,
    fileSystem,
    lock: {
      clock: {
        monotonicNow: () => performance.now(),
        now: () => Date.now(),
        wait: (milliseconds) =>
          new Promise((resolve) => setTimeout(resolve, milliseconds)),
      },
      processId: process.pid,
      randomBytes: (length) => randomBytes(length),
    },
    now: () => new Date().toISOString(),
  };
}

function rejection(error: unknown): ConsoleActionResult {
  const code =
    error instanceof InstallerError ? error.code : "INSTALLATION_UNAVAILABLE";
  return Object.freeze({
    kind: "rejected",
    code,
    message: installerErrorMessages[code] ?? "The operation failed.",
  });
}

export async function createConsoleService(
  options: ConsoleServiceOptions,
): Promise<ConsoleService> {
  const platform = options.platform ?? process.platform;
  const contract = resolvePathSafetyContract({ platform });
  const fileSystem = options.fileSystem ?? createNodeFileSystem({ platform });
  const environment =
    options.environment ?? createProcessInstallerEnvironment();
  const resolveExecutable =
    options.resolveExecutable ?? createNodeExecutableResolver();
  const resolveHomeDirectory =
    options.resolveHomeDirectory ?? resolveNodeOperatingSystemHome;
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const dependencies = dependenciesFor(fileSystem, environment, contract);

  let registry: ValidatedRegistry | undefined;
  let snapshot: HarnessDetectionSnapshot | undefined;
  let cached: ConsoleInventory | undefined;
  let mutating = false;

  async function detect(): Promise<HarnessDetectionSnapshot> {
    return detectHarnesses({
      resolveHomeDirectory,
      resolveExecutable,
      configEvidenceProbes: createNodeTargetConfigEvidenceProbes({
        environment,
        fileSystem,
        platform,
        contract,
      }),
    });
  }

  async function read(
    readOptions: { readonly refresh?: boolean } = {},
  ): Promise<ConsoleInventory> {
    if (cached !== undefined && readOptions.refresh !== true) return cached;
    registry ??= await loadBundledRegistry(
      fileSystem,
      registryCompatibilityAdapters,
    );
    snapshot = await detect();
    const discovery = await discoverEngineProjects({
      currentUserId: dependencies.currentUserId,
      contract,
      directoryReader: fileSystem,
      fileSystem,
      roots: options.scanRoots,
    });
    cached = Object.freeze({
      inventory: await buildEngineInventory({
        dependencies,
        nodeExecutable,
        projects: discovery.projects,
        registry,
        snapshot,
      }),
      discovery: Object.freeze({
        roots: discovery.roots,
        inspectedDirectories: discovery.inspectedDirectories,
        truncated: discovery.truncated,
        rejected: Object.freeze(
          discovery.rejected.map((entry) =>
            Object.freeze({ path: entry.projectDirectory, code: entry.code }),
          ),
        ),
      }),
      homeDirectory: snapshot.homeDirectory,
      nodeExecutable,
    });
    return cached;
  }

  async function descriptorFor(
    request: ConsoleActionRequest,
    row: EngineInventoryRow,
  ): Promise<CapabilityInstallDescriptor> {
    if (request.action !== "install") {
      const targetId = request.targetIds[0];
      const descriptor =
        targetId === undefined
          ? undefined
          : managedDescriptorFor(row, targetId);
      if (descriptor === undefined) {
        throw new InstallerError("INSTALLATION_UNAVAILABLE");
      }
      return descriptor;
    }
    if (row.project !== undefined) {
      // The installer's own manifest, path, and entry-point rules decide what
      // gets written, exactly as they do for `invokta-installer install`.
      const source = await loadEngineInstallManifest({
        currentUserId: dependencies.currentUserId,
        contract,
        fileSystem,
        nodeExecutable,
        projectDirectory: row.project.projectDirectory,
      });
      return source.descriptor;
    }
    const persisted = persistedInstallDescriptorFor(row);
    if (persisted === undefined) {
      throw new InstallerError("INSTALLATION_UNAVAILABLE");
    }
    return persisted;
  }

  async function apply(
    request: ConsoleActionRequest,
  ): Promise<ConsoleActionResult> {
    if (mutating) return Object.freeze({ kind: "busy" });
    mutating = true;
    try {
      const current = await read();
      const row = current.inventory.engines.find(
        (engine) => engine.id === request.engineId,
      );
      if (row === undefined || request.targetIds.length === 0) {
        throw new InstallerError("INSTALLATION_UNAVAILABLE");
      }
      if (request.action !== "install" && request.targetIds.length !== 1) {
        throw new InstallerError("INSTALLATION_UNAVAILABLE");
      }
      const descriptor = await descriptorFor(request, row);
      const active = snapshot;
      if (active === undefined) throw new InstallerError("STATE_INVALID");

      const results = await mutateDescriptorAcrossTargets({
        action: request.action,
        dependencies,
        descriptor,
        snapshot: active,
        targetIds: request.targetIds,
      });
      cached = undefined;
      return Object.freeze({
        kind: "applied",
        results: Object.freeze(
          results.map((result) => {
            const target = active.targets.find(
              ({ id }) => id === result.targetId,
            );
            return Object.freeze({
              targetId: result.targetId,
              displayName: target?.displayName ?? result.targetId,
              outcome: result.outcome,
              ...(target === undefined
                ? {}
                : { reloadHint: target.reloadHint }),
              ...(result.outcome === "failed"
                ? {
                    code: result.code,
                    message: installerErrorMessages[result.code],
                  }
                : {}),
            });
          }),
        ),
      });
    } catch (error) {
      return rejection(error);
    } finally {
      mutating = false;
    }
  }

  return Object.freeze({ read, apply });
}
