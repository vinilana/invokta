import { isAbsolute, relative, resolve, sep } from "node:path";

import type {
  InstallerFileStat,
  InstallerReadHandle,
  InstallerTransactionFileSystem,
  InstallerWriteHandle,
} from "./file-system.js";
import type {
  ConfigurationTargetSnapshot,
  HarnessDetectionSnapshot,
} from "./harness-detection.js";
import { InstallerError } from "./installer-error.js";
import {
  acquireInstallerLocks,
  type InstallerLockDependencies,
} from "./installer-lock.js";
import {
  installationKey,
  isInstallerTimestampAfter,
  loadInstallerState,
  type StateTargetContracts,
} from "./installer-state.js";
import {
  applyInstallerStatePlan,
  serializeInstallerState,
} from "./installer-state-transition.js";
import {
  type InstallerAction,
  planInstallerAction,
  planOwnership,
} from "./ownership-planner.js";
import {
  bootstrapPrivateDirectory,
  capturePathIdentity,
  capturePathRoot,
  type InstallerPathIdentity,
  revalidatePathIdentity,
} from "./path-identity.js";
import type {
  CapabilityInstallDescriptor,
  ConfigurationTargetId,
} from "./registry.js";
import {
  type TargetAdapter,
  type TargetPatch,
  targetConfigByteLimit,
} from "./target-adapter.js";
import type { InstallerEnvironment } from "./target-config-evidence.js";

export interface MutationCoordinatorDependencies {
  readonly adapters: Readonly<Record<ConfigurationTargetId, TargetAdapter>>;
  readonly currentUserId: number;
  readonly environment: InstallerEnvironment;
  readonly fileSystem: InstallerTransactionFileSystem;
  readonly lock: Omit<InstallerLockDependencies, "fileSystem">;
  readonly now: () => string;
}

export type TargetMutationResult =
  | {
      readonly targetId: ConfigurationTargetId;
      readonly outcome:
        | "disabled"
        | "enabled"
        | "installed"
        | "removed"
        | "unchanged";
    }
  | {
      readonly targetId: ConfigurationTargetId;
      readonly outcome: "failed";
      readonly code: InstallerError["code"];
    };

export interface InstallDescriptorAcrossTargetsInput {
  readonly dependencies: MutationCoordinatorDependencies;
  readonly descriptor: CapabilityInstallDescriptor;
  readonly snapshot: HarnessDetectionSnapshot;
  readonly targetIds: readonly ConfigurationTargetId[];
}

export interface MutateDescriptorAcrossTargetsInput
  extends InstallDescriptorAcrossTargetsInput {
  readonly action:
    | Extract<InstallerAction, "disable" | "enable" | "install">
    | "remove";
}

const temporaryTokenBytes = 12;

function inside(root: string, candidate: string): boolean {
  const difference = relative(resolve(root), resolve(candidate));
  return (
    difference === "" ||
    (difference !== ".." &&
      !difference.startsWith(`..${sep}`) &&
      !isAbsolute(difference))
  );
}

export function buildStateTargetContracts(
  snapshot: HarnessDetectionSnapshot,
  adapters: MutationCoordinatorDependencies["adapters"],
): StateTargetContracts {
  return Object.freeze(
    Object.fromEntries(
      snapshot.targets.flatMap((target) => {
        if (target.configuration.kind === "blocked") return [];
        const metadata = adapters[target.id].metadata;
        return [
          [
            target.id,
            Object.freeze({
              configPath: target.configuration.path,
              targetContractVersion: metadata.targetContractVersion,
              toggleStrategy: metadata.toggleStrategy,
            }),
          ],
        ];
      }),
    ) as unknown as StateTargetContracts,
  );
}

function sameStat(
  expected: InstallerFileStat | undefined,
  actual: InstallerFileStat,
): boolean {
  return (
    expected !== undefined &&
    expected.kind === actual.kind &&
    expected.dev === actual.dev &&
    expected.ino === actual.ino &&
    expected.uid === actual.uid &&
    expected.gid === actual.gid
  );
}

async function readCapturedFile(
  fileSystem: InstallerTransactionFileSystem,
  identity: InstallerPathIdentity,
  maximumBytes: number,
  errorCode: "HARNESS_CONFIG_READ_FAILED" | "STATE_READ_FAILED",
): Promise<Uint8Array | undefined> {
  if (identity.missingPaths.length > 0) return undefined;
  let handle: InstallerReadHandle | undefined;
  try {
    handle = await fileSystem.openReadNoFollow(identity.targetPath);
    if (!sameStat(identity.components.at(-1), await handle.stat())) {
      throw new InstallerError(
        errorCode === "STATE_READ_FAILED" ? "STATE_CHANGED" : "CONFIG_CHANGED",
      );
    }
    return await handle.readAll(maximumBytes);
  } catch (cause) {
    if (cause instanceof InstallerError) throw cause;
    throw new InstallerError(errorCode, cause);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function ensureParentDirectory(
  dependencies: MutationCoordinatorDependencies,
  root: Awaited<ReturnType<typeof capturePathRoot>>,
  targetPath: string,
  unsafeCode: "HARNESS_CONFIG_UNSAFE" | "STATE_INVALID",
): Promise<void> {
  const parentPath = resolve(targetPath, "..");
  if (!inside(root.path, parentPath)) {
    throw new InstallerError(unsafeCode);
  }
  try {
    const identity = await capturePathIdentity(dependencies.fileSystem, {
      root,
      targetPath: parentPath,
      targetKind: "directory",
    });
    await bootstrapPrivateDirectory(dependencies.fileSystem, {
      expected: identity,
    });
  } catch (cause) {
    throw new InstallerError(unsafeCode, cause);
  }
}

function randomToken(randomBytes: (length: number) => Uint8Array): string {
  const bytes = randomBytes(temporaryTokenBytes);
  if (bytes.byteLength !== temporaryTokenBytes) {
    throw new InstallerError("CONFIG_WRITE_FAILED");
  }
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function atomicReplace(
  dependencies: MutationCoordinatorDependencies,
  identity: InstallerPathIdentity,
  bytes: Uint8Array,
  failureCode: "CONFIG_WRITE_FAILED" | "STATE_WRITE_FAILED",
): Promise<void> {
  const { fileSystem } = dependencies;
  const temporaryPath = `${identity.targetPath}.tmp.${randomToken(dependencies.lock.randomBytes)}`;
  let created = false;
  let handle: InstallerWriteHandle | undefined;
  try {
    handle = await fileSystem.createExclusiveNoFollow(temporaryPath, 0o600);
    created = true;
    await handle.writeAll(bytes);
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await revalidatePathIdentity(fileSystem, identity);
    await fileSystem.rename(temporaryPath, identity.targetPath);
    created = false;
  } catch (cause) {
    await handle?.close().catch(() => undefined);
    if (created) await fileSystem.unlink(temporaryPath).catch(() => undefined);
    if (cause instanceof InstallerError) throw cause;
    throw new InstallerError(failureCode, cause);
  }
}

async function rollbackConfig(
  dependencies: MutationCoordinatorDependencies,
  root: Awaited<ReturnType<typeof capturePathRoot>>,
  configPath: string,
  original: Uint8Array | undefined,
): Promise<void> {
  try {
    const current = await capturePathIdentity(dependencies.fileSystem, {
      root,
      targetPath: configPath,
      targetKind: "regular-file",
    });
    if (original === undefined) {
      if (current.missingPaths.length === 0) {
        await dependencies.fileSystem.unlink(configPath);
      }
    } else {
      await atomicReplace(
        dependencies,
        current,
        original,
        "CONFIG_WRITE_FAILED",
      );
    }
  } catch (cause) {
    throw new InstallerError("CONFIG_ROLLBACK_FAILED", cause);
  }
}

function findTarget(
  snapshot: HarnessDetectionSnapshot,
  targetId: ConfigurationTargetId,
): ConfigurationTargetSnapshot & {
  readonly configuration: Exclude<
    ConfigurationTargetSnapshot["configuration"],
    { readonly kind: "blocked" }
  >;
} {
  const target = snapshot.targets.find(({ id }) => id === targetId);
  if (
    target === undefined ||
    !target.eligible ||
    target.configuration.kind === "blocked"
  ) {
    throw new InstallerError("TARGET_UNSUPPORTED");
  }
  return target as ConfigurationTargetSnapshot & {
    readonly configuration: Exclude<
      ConfigurationTargetSnapshot["configuration"],
      { readonly kind: "blocked" }
    >;
  };
}

function nextTimestamp(
  candidate: string,
  previous: string | undefined,
): string {
  if (
    previous === undefined ||
    isInstallerTimestampAfter(candidate, previous)
  ) {
    return candidate;
  }
  const milliseconds = Date.parse(previous);
  if (!Number.isFinite(milliseconds)) throw new InstallerError("STATE_INVALID");
  return new Date(milliseconds + 1).toISOString();
}

async function mutateTarget(
  input: MutateDescriptorAcrossTargetsInput,
  targetId: ConfigurationTargetId,
  contracts: StateTargetContracts,
): Promise<"disabled" | "enabled" | "installed" | "removed" | "unchanged"> {
  const { dependencies, descriptor, snapshot } = input;
  const target = findTarget(snapshot, targetId);
  const configPath = target.configuration.path;
  const adapter = dependencies.adapters[targetId];
  const compatibility = adapter.compatibility(descriptor);
  if (!compatibility.supported) throw new InstallerError("TARGET_UNSUPPORTED");

  const loadedBeforeLock = await loadInstallerState({
    currentUserId: dependencies.currentUserId,
    environment: dependencies.environment,
    fileSystem: dependencies.fileSystem,
    homeDirectory: snapshot.homeDirectory,
    targetContracts: contracts,
  });
  const homeRoot = await capturePathRoot(dependencies.fileSystem, {
    rootKind: "home",
    rootPath: snapshot.homeDirectory,
    currentUserId: dependencies.currentUserId,
  }).catch((cause) => {
    throw new InstallerError("HARNESS_CONFIG_UNSAFE", cause);
  });
  await ensureParentDirectory(
    dependencies,
    homeRoot,
    configPath,
    "HARNESS_CONFIG_UNSAFE",
  );
  const stateRoot = inside(homeRoot.path, loadedBeforeLock.path)
    ? homeRoot
    : await capturePathRoot(dependencies.fileSystem, {
        rootKind: "state",
        rootPath: resolve(loadedBeforeLock.path, "../.."),
        currentUserId: dependencies.currentUserId,
      }).catch((cause) => {
        throw new InstallerError("STATE_INVALID", cause);
      });
  await ensureParentDirectory(
    dependencies,
    stateRoot,
    loadedBeforeLock.path,
    "STATE_INVALID",
  );

  const locks = await acquireInstallerLocks({
    configPath,
    statePath: loadedBeforeLock.path,
    dependencies: { ...dependencies.lock, fileSystem: dependencies.fileSystem },
  });
  let primaryError: unknown;
  try {
    const loaded = await loadInstallerState({
      currentUserId: dependencies.currentUserId,
      environment: dependencies.environment,
      fileSystem: dependencies.fileSystem,
      homeDirectory: snapshot.homeDirectory,
      targetContracts: contracts,
    });
    if (loaded.path !== loadedBeforeLock.path) {
      throw new InstallerError("STATE_CHANGED");
    }
    const configIdentity = await capturePathIdentity(dependencies.fileSystem, {
      root: homeRoot,
      targetPath: configPath,
      targetKind: "regular-file",
    });
    const stateIdentity = await capturePathIdentity(dependencies.fileSystem, {
      root: stateRoot,
      targetPath: loaded.path,
      targetKind: "regular-file",
    });
    const source = await readCapturedFile(
      dependencies.fileSystem,
      configIdentity,
      targetConfigByteLimit,
      "HARNESS_CONFIG_READ_FAILED",
    );
    const inspection = adapter.inspect({
      source,
      serverName: descriptor.server.name,
    });
    const registryDefinition = adapter.descriptorToDefinition(descriptor);
    const managedInstallation =
      loaded.state.installations[
        installationKey(descriptor.id, targetId, configPath)
      ];
    const planning = {
      descriptor,
      targetId,
      target: contracts[targetId],
      state: loaded.state,
      registryDefinition,
      ...(managedInstallation?.suspendedDescriptor === undefined
        ? {}
        : {
            normalizedSuspendedDefinition:
              adapter.suspendedDescriptorToDefinition(
                managedInstallation.suspendedDescriptor,
              ),
          }),
      currentServer: inspection.currentServer,
    } as const;
    let stateBytes: Uint8Array;
    let patch: TargetPatch;
    if (input.action === "remove") {
      if (managedInstallation === undefined) {
        throw new InstallerError("INSTALLATION_UNAVAILABLE");
      }
      const ownership = planOwnership(planning);
      if (ownership.status === "drifted") {
        throw new InstallerError("CONFIG_DRIFT");
      }
      if (ownership.status === "conflict") {
        throw new InstallerError("CONFIG_CONFLICT");
      }
      const nextInstallations = { ...loaded.state.installations };
      delete nextInstallations[
        installationKey(descriptor.id, targetId, configPath)
      ];
      stateBytes = serializeInstallerState(
        { schemaVersion: 1, installations: nextInstallations },
        contracts,
      );
      patch =
        inspection.currentServer.kind === "absent"
          ? ({ kind: "unchanged" } as const)
          : adapter.constructPatch({ action: "remove", inspection });
    } else {
      const plan = planInstallerAction(planning, input.action);
      if (plan.outcome === "blocked") throw new InstallerError(plan.code);
      if (plan.outcome === "unchanged") return "unchanged";
      const transition = applyInstallerStatePlan({
        adapter,
        occurredAt: nextTimestamp(
          dependencies.now(),
          managedInstallation?.updatedAt,
        ),
        plan,
        planning,
        targetContracts: contracts,
      });
      if (transition === undefined) throw new InstallerError("STATE_INVALID");
      stateBytes = serializeInstallerState(transition.state, contracts);
      patch =
        input.action === "install"
          ? adapter.constructPatch({
              action: "install",
              definition: registryDefinition,
              inspection,
            })
          : input.action === "enable"
            ? adapter.constructPatch({
                action: "enable",
                ...(transition.restoreDefinition === undefined
                  ? {}
                  : { restoreDefinition: transition.restoreDefinition }),
                inspection,
              })
            : adapter.constructPatch({ action: "disable", inspection });
      if (patch.kind !== "changed") throw new InstallerError("STATE_INVALID");
    }

    const configPostImage =
      patch.kind === "changed" ? patch.postImage : undefined;
    if (configPostImage !== undefined) {
      await atomicReplace(
        dependencies,
        configIdentity,
        configPostImage,
        "CONFIG_WRITE_FAILED",
      );
    }
    try {
      await atomicReplace(
        dependencies,
        stateIdentity,
        stateBytes,
        "STATE_WRITE_FAILED",
      );
    } catch (cause) {
      if (configPostImage !== undefined) {
        await rollbackConfig(dependencies, homeRoot, configPath, source);
      }
      throw cause;
    }
    return input.action === "remove"
      ? "removed"
      : input.action === "install"
        ? "installed"
        : input.action === "enable"
          ? "enabled"
          : "disabled";
  } catch (cause) {
    primaryError = cause;
    throw cause;
  } finally {
    await locks.release(primaryError);
  }
}

export async function installDescriptorAcrossTargets(
  input: InstallDescriptorAcrossTargetsInput,
): Promise<readonly TargetMutationResult[]> {
  return mutateDescriptorAcrossTargets({ ...input, action: "install" });
}

export async function mutateDescriptorAcrossTargets(
  input: MutateDescriptorAcrossTargetsInput,
): Promise<readonly TargetMutationResult[]> {
  const contracts = buildStateTargetContracts(
    input.snapshot,
    input.dependencies.adapters,
  );
  const results: TargetMutationResult[] = [];
  const seen = new Set<ConfigurationTargetId>();
  for (const targetId of input.targetIds) {
    if (seen.has(targetId)) continue;
    seen.add(targetId);
    try {
      const outcome = await mutateTarget(input, targetId, contracts);
      results.push(Object.freeze({ targetId, outcome }));
    } catch (cause) {
      const error =
        cause instanceof InstallerError
          ? cause
          : new InstallerError("INSTALLER_INITIALIZATION_FAILED", cause);
      results.push(
        Object.freeze({ targetId, outcome: "failed", code: error.code }),
      );
    }
  }
  return Object.freeze(results);
}
