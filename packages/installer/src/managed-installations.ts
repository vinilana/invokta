import type { InstallerFileStat, InstallerReadHandle } from "./file-system.js";
import type { HarnessDetectionSnapshot } from "./harness-detection.js";
import { InstallerError } from "./installer-error.js";
import {
  loadInstallerState,
  type ManagedInstallation,
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
}

export interface InspectManagedInstallationsOptions {
  readonly dependencies: MutationCoordinatorDependencies;
  readonly registry: ValidatedRegistry;
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
  options: InspectManagedInstallationsOptions,
  identity: InstallerPathIdentity,
): Promise<Uint8Array | undefined> {
  if (identity.missingPaths.length > 0) return undefined;
  let handle: InstallerReadHandle | undefined;
  try {
    handle = await options.dependencies.fileSystem.openReadNoFollow(
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

function descriptorFor(
  installation: ManagedInstallation,
  registry: ValidatedRegistry,
): CapabilityInstallDescriptor | undefined {
  const registered = registry.entries.find(
    ({ descriptor }) => descriptor.id === installation.entryId,
  )?.descriptor;
  if (installation.launchDescriptor === undefined) return registered;
  return Object.freeze({
    id: installation.entryId,
    version: installation.registryVersion,
    title: installation.serverName,
    description: `Managed ${installation.serverName} MCP server.`,
    capabilityIds: Object.freeze([installation.entryId]),
    server: installation.launchDescriptor,
  });
}

function unavailable(
  key: string,
  installation: ManagedInstallation,
  descriptor: CapabilityInstallDescriptor | undefined,
  displayName: string,
): ManagedInstallationView {
  return Object.freeze({
    key,
    installation,
    ...(descriptor === undefined ? {} : { descriptor }),
    displayName,
    status: "unavailable",
    actions: Object.freeze([] as []),
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
    environment: options.dependencies.environment,
    fileSystem: options.dependencies.fileSystem,
    homeDirectory: options.snapshot.homeDirectory,
    targetContracts: contracts,
  });
  const homeRoot = await capturePathRoot(options.dependencies.fileSystem, {
    rootKind: "home",
    rootPath: options.snapshot.homeDirectory,
    currentUserId: options.dependencies.currentUserId,
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
    const displayName = target?.displayName ?? installation.targetId;
    if (
      descriptor === undefined ||
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
    const adapter = options.dependencies.adapters[installation.targetId];
    const inspection = adapter.inspect({
      source: await readConfig(options, identity),
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
