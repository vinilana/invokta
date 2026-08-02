import type { InstallerFileStat, InstallerReadHandle } from "./file-system.js";
import type { HarnessDetectionSnapshot } from "./harness-detection.js";
import { InstallerError, type InstallerErrorCode } from "./installer-error.js";
import {
  loadInstallerState,
  type ManagedInstallation,
  type StateTargetContracts,
} from "./installer-state.js";
import {
  buildStateTargetContracts,
  type MutationCoordinatorDependencies,
} from "./mutation-coordinator.js";
import { type OwnershipPlan, planOwnership } from "./ownership-planner.js";
import {
  capturePathIdentity,
  capturePathRoot,
  type InstallerPathIdentity,
} from "./path-identity.js";
import type {
  CapabilityInstallDescriptor,
  ValidatedRegistry,
} from "./registry.js";
import { targetConfigByteLimit } from "./target-adapter.js";

export interface ManagedInstallationView {
  readonly key: string;
  readonly installation: ManagedInstallation;
  readonly descriptor?: CapabilityInstallDescriptor;
  readonly displayName: string;
  readonly status: OwnershipPlan["status"] | "unavailable";
  readonly actions: OwnershipPlan["actions"];
  readonly unavailableCode?: InstallerErrorCode;
}

export interface InspectManagedInstallationsOptions {
  readonly dependencies: MutationCoordinatorDependencies;
  readonly registry: ValidatedRegistry;
  readonly snapshot: HarnessDetectionSnapshot;
}

export interface InspectEngineManagedInstallationsOptions {
  readonly dependencies: MutationCoordinatorDependencies;
  readonly engineId: string;
  readonly manifestServerName: string;
  readonly snapshot: HarnessDetectionSnapshot;
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

async function readConfig(
  dependencies: MutationCoordinatorDependencies,
  identity: InstallerPathIdentity,
): Promise<Uint8Array | undefined> {
  if (identity.missingPaths.length > 0) return undefined;
  let handle: InstallerReadHandle | undefined;
  try {
    handle = await dependencies.fileSystem.openReadNoFollow(
      identity.targetPath,
    );
    if (!sameStat(identity.components.at(-1), await handle.stat())) {
      throw new InstallerError("CONFIG_CHANGED");
    }
    return await handle.readAll(targetConfigByteLimit);
  } catch (cause) {
    if (cause instanceof InstallerError) throw cause;
    throw new InstallerError("HARNESS_CONFIG_READ_FAILED", cause);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function persistedDescriptorFor(
  installation: ManagedInstallation,
): CapabilityInstallDescriptor | undefined {
  if (installation.launchDescriptor === undefined) return undefined;
  return Object.freeze({
    id: installation.entryId,
    version: installation.registryVersion,
    title: installation.serverName,
    description: `Managed ${installation.serverName} MCP server.`,
    capabilityIds: Object.freeze([installation.entryId]),
    server: installation.launchDescriptor,
  });
}

function descriptorFor(
  installation: ManagedInstallation,
  registry: ValidatedRegistry,
): CapabilityInstallDescriptor | undefined {
  const registered = registry.entries.find(
    ({ descriptor }) => descriptor.id === installation.entryId,
  )?.descriptor;
  return persistedDescriptorFor(installation) ?? registered;
}

function unavailable(
  key: string,
  installation: ManagedInstallation,
  descriptor: CapabilityInstallDescriptor | undefined,
  displayName: string,
  code?: InstallerErrorCode,
): ManagedInstallationView {
  return Object.freeze({
    key,
    installation,
    ...(descriptor === undefined ? {} : { descriptor }),
    displayName,
    status: "unavailable",
    actions: Object.freeze([] as []),
    ...(code === undefined ? {} : { unavailableCode: code }),
  });
}

export async function inspectManagedInstallations(
  options: InspectManagedInstallationsOptions,
): Promise<readonly ManagedInstallationView[]> {
  const contracts = buildStateTargetContracts(
    options.snapshot,
    options.dependencies.adapters,
  );
  const loaded = await loadInstallerState({
    currentUserId: options.dependencies.currentUserId,
    ...(options.dependencies.contract === undefined
      ? {}
      : { contract: options.dependencies.contract }),
    environment: options.dependencies.environment,
    fileSystem: options.dependencies.fileSystem,
    homeDirectory: options.snapshot.homeDirectory,
    targetContracts: contracts,
    allowUnavailableTargetContracts: true,
  });
  const homeRoot = await capturePathRoot(options.dependencies.fileSystem, {
    rootKind: "home",
    rootPath: options.snapshot.homeDirectory,
    currentUserId: options.dependencies.currentUserId,
    ...(options.dependencies.contract === undefined
      ? {}
      : { contract: options.dependencies.contract }),
  }).catch((cause) => {
    throw new InstallerError("HARNESS_CONFIG_UNSAFE", cause);
  });
  const views: ManagedInstallationView[] = [];
  const entries = Object.entries(loaded.state.installations).sort(
    ([left], [right]) => left.localeCompare(right),
  );
  for (const [key, installation] of entries) {
    const descriptor = descriptorFor(installation, options.registry);
    const target = options.snapshot.targets.find(
      ({ id }) => id === installation.targetId,
    );
    const adapter = options.dependencies.adapters[installation.targetId];
    const displayName = target?.displayName ?? installation.targetId;
    if (
      descriptor === undefined ||
      !adapter.compatibility(descriptor).supported ||
      target === undefined ||
      target.configuration.kind === "blocked" ||
      target.configuration.path !== installation.configPath ||
      contracts[installation.targetId] === undefined
    ) {
      views.push(unavailable(key, installation, descriptor, displayName));
      continue;
    }
    const identity = await capturePathIdentity(
      options.dependencies.fileSystem,
      {
        root: homeRoot,
        targetPath: installation.configPath,
        targetKind: "regular-file",
      },
    ).catch((cause) => {
      throw new InstallerError("HARNESS_CONFIG_UNSAFE", cause);
    });
    const inspection = adapter.inspect({
      source: await readConfig(options.dependencies, identity),
      serverName: installation.serverName,
    });
    const ownership = planOwnership({
      descriptor,
      targetId: installation.targetId,
      target: contracts[installation.targetId],
      state: loaded.state,
      registryDefinition: adapter.descriptorToDefinition(descriptor),
      ...(installation.suspendedDescriptor === undefined
        ? {}
        : {
            normalizedSuspendedDefinition:
              adapter.suspendedDescriptorToDefinition(
                installation.suspendedDescriptor,
              ),
          }),
      currentServer: inspection.currentServer,
    });
    views.push(
      Object.freeze({
        key,
        installation,
        descriptor,
        displayName,
        status: ownership.status,
        actions: ownership.actions,
      }),
    );
  }
  return Object.freeze(views);
}

function unavailableCode(
  cause: unknown,
  fallback: InstallerErrorCode,
): InstallerErrorCode {
  return cause instanceof InstallerError ? cause.code : fallback;
}

export async function inspectEngineManagedInstallations(
  options: InspectEngineManagedInstallationsOptions,
): Promise<readonly ManagedInstallationView[]> {
  const contracts = buildStateTargetContracts(
    options.snapshot,
    options.dependencies.adapters,
  );
  const loaded = await loadInstallerState({
    currentUserId: options.dependencies.currentUserId,
    ...(options.dependencies.contract === undefined
      ? {}
      : { contract: options.dependencies.contract }),
    environment: options.dependencies.environment,
    fileSystem: options.dependencies.fileSystem,
    homeDirectory: options.snapshot.homeDirectory,
    targetContracts: Object.freeze({}) as StateTargetContracts,
    allowUnavailableTargetContracts: true,
  });
  const allEntries = Object.entries(loaded.state.installations);
  if (
    allEntries.some(
      ([, installation]) =>
        installation.entryId !== options.engineId &&
        installation.serverName === options.manifestServerName,
    )
  ) {
    throw new InstallerError("ENGINE_IDENTITY_MISMATCH");
  }
  const targetOrder = new Map(
    options.snapshot.targets.map(({ id }, index) => [id, index] as const),
  );
  const entries = allEntries
    .filter(([, installation]) => installation.entryId === options.engineId)
    .sort(
      ([, left], [, right]) =>
        (targetOrder.get(left.targetId) ?? Number.MAX_SAFE_INTEGER) -
        (targetOrder.get(right.targetId) ?? Number.MAX_SAFE_INTEGER),
    );
  if (entries.length === 0) return Object.freeze([]);

  const homeRoot = await capturePathRoot(options.dependencies.fileSystem, {
    rootKind: "home",
    rootPath: options.snapshot.homeDirectory,
    currentUserId: options.dependencies.currentUserId,
    ...(options.dependencies.contract === undefined
      ? {}
      : { contract: options.dependencies.contract }),
  }).catch((cause) => {
    throw new InstallerError("HARNESS_CONFIG_UNSAFE", cause);
  });
  const views: ManagedInstallationView[] = [];
  for (const [key, installation] of entries) {
    const descriptor = persistedDescriptorFor(installation);
    const target = options.snapshot.targets.find(
      ({ id }) => id === installation.targetId,
    );
    const displayName = target?.displayName ?? installation.targetId;
    if (descriptor === undefined) {
      views.push(
        unavailable(
          key,
          installation,
          descriptor,
          displayName,
          "INSTALLATION_UNAVAILABLE",
        ),
      );
      continue;
    }
    if (target === undefined) {
      views.push(
        unavailable(
          key,
          installation,
          descriptor,
          displayName,
          "TARGET_UNSUPPORTED",
        ),
      );
      continue;
    }
    if (target.configuration.kind === "blocked") {
      views.push(
        unavailable(
          key,
          installation,
          descriptor,
          displayName,
          target.configuration.code,
        ),
      );
      continue;
    }
    const contract = contracts[installation.targetId];
    const adapter = options.dependencies.adapters[installation.targetId];
    if (
      contract === undefined ||
      target.configuration.path !== installation.configPath ||
      contract.targetContractVersion !== installation.targetContractVersion ||
      contract.toggleStrategy !== installation.toggleStrategy
    ) {
      views.push(
        unavailable(
          key,
          installation,
          descriptor,
          displayName,
          "HARNESS_CONFIG_UNSAFE",
        ),
      );
      continue;
    }
    if (!adapter.compatibility(descriptor).supported) {
      views.push(
        unavailable(
          key,
          installation,
          descriptor,
          displayName,
          "TARGET_UNSUPPORTED",
        ),
      );
      continue;
    }

    try {
      const identity = await capturePathIdentity(
        options.dependencies.fileSystem,
        {
          root: homeRoot,
          targetPath: installation.configPath,
          targetKind: "regular-file",
        },
      );
      const inspection = adapter.inspect({
        source: await readConfig(options.dependencies, identity),
        serverName: installation.serverName,
      });
      const ownership = planOwnership({
        descriptor,
        targetId: installation.targetId,
        target: contract,
        state: loaded.state,
        registryDefinition: adapter.descriptorToDefinition(descriptor),
        ...(installation.suspendedDescriptor === undefined
          ? {}
          : {
              normalizedSuspendedDefinition:
                adapter.suspendedDescriptorToDefinition(
                  installation.suspendedDescriptor,
                ),
            }),
        currentServer: inspection.currentServer,
      });
      views.push(
        Object.freeze({
          key,
          installation,
          descriptor,
          displayName,
          status: ownership.status,
          actions: ownership.actions,
        }),
      );
    } catch (cause) {
      views.push(
        unavailable(
          key,
          installation,
          descriptor,
          displayName,
          unavailableCode(cause, "HARNESS_CONFIG_UNSAFE"),
        ),
      );
    }
  }
  return Object.freeze(views);
}
