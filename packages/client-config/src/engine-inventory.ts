/**
 * The read model every Invokta front end renders.
 *
 * One row per Action Engine identity, one column per configuration target, and
 * one cell per pair. A cell says either what the installer owns there, or
 * whether it could install there and, when it could not, a stable reason. That
 * turns "where is this engine, and where could it go" into data instead of
 * something each front end has to derive from the catalog by itself.
 *
 * Building the inventory performs no write and asks for no confirmation.
 */

import type { EngineProjectMetadata } from "./engine-manifest.js";
import type { HarnessDetectionSnapshot } from "./harness-detection.js";
import type { InstallerErrorCode } from "./installer-error.js";
import type { ManagedInstallation } from "./installer-state.js";
import {
  inspectManagedInstallations,
  type ManagedInstallationView,
} from "./managed-installations.js";
import type { MutationCoordinatorDependencies } from "./mutation-coordinator.js";
import type { OwnershipPlan } from "./ownership-planner.js";
import type {
  CapabilityInstallDescriptor,
  ConfigurationTargetId,
  ValidatedRegistry,
} from "./registry.js";

export type EngineDescriptorSource = "project" | "state";

export type EngineInventoryBlockedReason =
  /** The target itself is unusable; the code is the target's own evidence code. */
  | { readonly code: "TARGET_BLOCKED"; readonly targetCode: InstallerErrorCode }
  /** No client executable and no user configuration to write into. */
  | { readonly code: "TARGET_INELIGIBLE" }
  /** The adapter refuses this descriptor shape, with its stable reason. */
  | { readonly code: "TARGET_INCOMPATIBLE"; readonly reason: string }
  /** Neither a project manifest nor a persisted launch descriptor is available. */
  | { readonly code: "DESCRIPTOR_UNAVAILABLE" };

export type EngineInventoryCell =
  | {
      readonly state: "managed";
      readonly status: ManagedInstallationView["status"];
      readonly actions: OwnershipPlan["actions"];
      readonly installation: ManagedInstallation;
      readonly unavailableCode?: InstallerErrorCode;
    }
  | { readonly state: "installable" }
  | { readonly state: "needs-build" }
  | {
      readonly state: "unavailable";
      readonly reason: EngineInventoryBlockedReason;
    };

export interface EngineInventoryRow {
  readonly id: string;
  readonly title: string;
  readonly version: string;
  readonly description: string;
  readonly serverName: string;
  readonly capabilityIds: readonly string[];
  readonly descriptorSource: EngineDescriptorSource | "none";
  readonly project?: EngineProjectMetadata;
  readonly cells: Readonly<Record<ConfigurationTargetId, EngineInventoryCell>>;
  readonly installedCount: number;
  readonly reachableCount: number;
}

export interface EngineInventory {
  readonly targets: HarnessDetectionSnapshot["targets"];
  readonly engines: readonly EngineInventoryRow[];
}

export interface BuildEngineInventoryOptions {
  readonly dependencies: MutationCoordinatorDependencies;
  readonly nodeExecutable: string;
  readonly projects: readonly EngineProjectMetadata[];
  readonly registry: ValidatedRegistry;
  readonly snapshot: HarnessDetectionSnapshot;
}

interface EngineDraft {
  id: string;
  title: string;
  version: string;
  description: string;
  serverName: string;
  capabilityIds: readonly string[];
  descriptorSource: EngineDescriptorSource | "none";
  project?: EngineProjectMetadata;
  descriptor?: CapabilityInstallDescriptor;
  cells: Record<string, EngineInventoryCell>;
}

function projectDescriptor(
  project: EngineProjectMetadata,
  nodeExecutable: string,
): CapabilityInstallDescriptor {
  const { manifest } = project;
  return Object.freeze({
    id: manifest.id,
    version: manifest.version,
    title: manifest.title,
    description: manifest.description,
    capabilityIds: manifest.capabilityIds,
    server: Object.freeze({
      name: manifest.server.name,
      transport: Object.freeze({
        type: "stdio" as const,
        command: nodeExecutable,
        args: Object.freeze([project.entrypointPath]),
        forwardEnv: manifest.server.forwardEnv,
      }),
    }),
  });
}

function persistedDescriptor(
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

function blocked(reason: EngineInventoryBlockedReason): EngineInventoryCell {
  return Object.freeze({ state: "unavailable", reason });
}

function absentCell(
  target: HarnessDetectionSnapshot["targets"][number],
  draft: EngineDraft,
  dependencies: MutationCoordinatorDependencies,
): EngineInventoryCell {
  if (target.configuration.kind === "blocked") {
    return blocked({
      code: "TARGET_BLOCKED",
      targetCode: target.configuration.code,
    });
  }
  if (draft.descriptor === undefined) {
    return blocked({ code: "DESCRIPTOR_UNAVAILABLE" });
  }
  const compatibility = dependencies.adapters[target.id].compatibility(
    draft.descriptor,
  );
  if (!compatibility.supported) {
    return blocked({
      code: "TARGET_INCOMPATIBLE",
      reason: compatibility.reason,
    });
  }
  if (!target.eligible) return blocked({ code: "TARGET_INELIGIBLE" });
  if (draft.project !== undefined && !draft.project.entrypointBuilt) {
    return Object.freeze({ state: "needs-build" });
  }
  return Object.freeze({ state: "installable" });
}

function managedCell(view: ManagedInstallationView): EngineInventoryCell {
  return Object.freeze({
    state: "managed",
    status: view.status,
    actions: view.actions,
    installation: view.installation,
    ...(view.unavailableCode === undefined
      ? {}
      : { unavailableCode: view.unavailableCode }),
  });
}

function draftFor(engines: Map<string, EngineDraft>, id: string): EngineDraft {
  const existing = engines.get(id);
  if (existing !== undefined) return existing;
  const created: EngineDraft = {
    id,
    title: id,
    version: "",
    description: "",
    serverName: id,
    capabilityIds: Object.freeze([]),
    descriptorSource: "none",
    cells: {},
  };
  engines.set(id, created);
  return created;
}

export async function buildEngineInventory(
  options: BuildEngineInventoryOptions,
): Promise<EngineInventory> {
  const views = await inspectManagedInstallations({
    dependencies: options.dependencies,
    registry: options.registry,
    snapshot: options.snapshot,
  });
  const engines = new Map<string, EngineDraft>();

  for (const project of options.projects) {
    const draft = draftFor(engines, project.manifest.id);
    draft.title = project.manifest.title;
    draft.version = project.manifest.version;
    draft.description = project.manifest.description;
    draft.serverName = project.manifest.server.name;
    draft.capabilityIds = project.manifest.capabilityIds;
    draft.project = project;
    draft.descriptorSource = "project";
    draft.descriptor = projectDescriptor(project, options.nodeExecutable);
  }

  for (const view of views) {
    const draft = draftFor(engines, view.installation.entryId);
    draft.cells[view.installation.targetId] = managedCell(view);
    if (draft.descriptor !== undefined) continue;
    const descriptor = persistedDescriptor(view.installation);
    if (descriptor === undefined) continue;
    draft.descriptor = descriptor;
    draft.descriptorSource = "state";
    draft.serverName = view.installation.serverName;
    draft.version = view.installation.registryVersion;
  }

  const rows: EngineInventoryRow[] = [];
  for (const draft of engines.values()) {
    for (const target of options.snapshot.targets) {
      if (draft.cells[target.id] !== undefined) continue;
      draft.cells[target.id] = absentCell(target, draft, options.dependencies);
    }
    const cells = Object.values(draft.cells);
    rows.push(
      Object.freeze({
        id: draft.id,
        title: draft.title,
        version: draft.version,
        description: draft.description,
        serverName: draft.serverName,
        capabilityIds: draft.capabilityIds,
        descriptorSource: draft.descriptorSource,
        ...(draft.project === undefined ? {} : { project: draft.project }),
        cells: Object.freeze({ ...draft.cells }) as EngineInventoryRow["cells"],
        installedCount: cells.filter((cell) => cell.state === "managed").length,
        reachableCount: cells.filter((cell) => cell.state !== "unavailable")
          .length,
      }),
    );
  }

  return Object.freeze({
    targets: options.snapshot.targets,
    engines: Object.freeze(
      rows.sort((left, right) => left.id.localeCompare(right.id)),
    ),
  });
}

/**
 * The persisted descriptor that owns one registration.
 *
 * Enable, disable, and remove must act on exactly what the installer wrote, so
 * they read it back from state rather than reconstructing it from the current
 * manifest or the registry — the two can legitimately disagree after a project
 * moves or changes version.
 */
export function managedDescriptorFor(
  row: EngineInventoryRow,
  targetId: ConfigurationTargetId,
): CapabilityInstallDescriptor | undefined {
  const cell = row.cells[targetId];
  if (cell?.state !== "managed") return undefined;
  return persistedDescriptor(cell.installation);
}

/**
 * The descriptor that installs an engine known only from installer state.
 *
 * A project on disk always installs through `loadEngineInstallManifest`, so its
 * manifest, path, and entry-point rules decide what is written. This fallback
 * covers an engine whose project is gone but whose launch descriptor is still
 * recorded, which is what lets it be installed into one more client.
 */
export function persistedInstallDescriptorFor(
  row: EngineInventoryRow,
): CapabilityInstallDescriptor | undefined {
  if (row.project !== undefined) return undefined;
  for (const cell of Object.values(row.cells)) {
    if (cell.state !== "managed") continue;
    const descriptor = persistedDescriptor(cell.installation);
    if (descriptor !== undefined) return descriptor;
  }
  return undefined;
}
