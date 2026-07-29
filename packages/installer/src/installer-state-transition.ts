import { InstallerError } from "./installer-error.js";
import {
  installationKey,
  type InstallerState,
  isInstallerTimestampAfter,
  type ManagedInstallation,
  type StateTargetContracts,
  validateInstallerStateBytes,
} from "./installer-state.js";
import {
  canonicalizeJcs,
  fingerprintNormalizedDefinition,
} from "./jcs-fingerprint.js";
import {
  type InstallerActionPlan,
  type OwnershipPlanningInput,
  planInstallerAction,
} from "./ownership-planner.js";
import type { TargetAdapter } from "./target-adapter.js";

export interface ApplyInstallerStatePlanInput {
  readonly adapter: TargetAdapter;
  readonly occurredAt: string;
  readonly plan: InstallerActionPlan;
  readonly planning: OwnershipPlanningInput;
  readonly targetContracts: StateTargetContracts;
}

export interface InstallerStateWriteTransition {
  readonly state: InstallerState;
  readonly bytes: Uint8Array;
  readonly installation: ManagedInstallation;
  readonly restoreDefinition?: Readonly<Record<string, unknown>>;
}

interface NormalizedStateSerialization {
  readonly state: InstallerState;
  readonly bytes: Uint8Array;
}

const encoder = new TextEncoder();

function invalidState(): never {
  throw new InstallerError("STATE_INVALID");
}

function normalizeAndSerializeInstallerState(
  state: InstallerState,
  targetContracts: StateTargetContracts,
): NormalizedStateSerialization {
  let bytes: Uint8Array;
  try {
    bytes = encoder.encode(`${canonicalizeJcs(state)}\n`);
  } catch {
    return invalidState();
  }
  const validation = validateInstallerStateBytes(bytes, targetContracts);
  if (!validation.ok) return invalidState();
  return Object.freeze({ state: validation.state, bytes });
}

export function serializeInstallerState(
  state: InstallerState,
  targetContracts: StateTargetContracts,
): Uint8Array {
  return normalizeAndSerializeInstallerState(state, targetContracts).bytes;
}

function plansMatch(
  expected: InstallerActionPlan,
  received: InstallerActionPlan,
): boolean {
  if (
    expected.outcome !== received.outcome ||
    expected.action !== received.action ||
    expected.configEffect !== received.configEffect ||
    expected.stateEffect !== received.stateEffect
  ) {
    return false;
  }
  if (expected.outcome === "blocked" || received.outcome === "blocked") {
    return (
      expected.outcome === "blocked" &&
      received.outcome === "blocked" &&
      expected.code === received.code
    );
  }
  if (expected.outcome === "write" || received.outcome === "write") {
    return (
      expected.outcome === "write" &&
      received.outcome === "write" &&
      expected.definitionSource === received.definitionSource
    );
  }
  return true;
}

function selectedCreateDefinition(
  plan: Extract<InstallerActionPlan, { readonly outcome: "write" }>,
  planning: OwnershipPlanningInput,
): Readonly<Record<string, unknown>> {
  if (plan.definitionSource === "registry") {
    return planning.registryDefinition;
  }
  if (
    plan.definitionSource === "current" &&
    planning.currentServer.kind === "present"
  ) {
    return planning.currentServer.definition;
  }
  return invalidState();
}

function createInstallation(
  plan: Extract<InstallerActionPlan, { readonly outcome: "write" }>,
  planning: OwnershipPlanningInput,
  occurredAt: string,
): ManagedInstallation {
  if (
    plan.stateEffect !== "create" ||
    (plan.action !== "install" && plan.action !== "adopt")
  ) {
    return invalidState();
  }
  const definition = selectedCreateDefinition(plan, planning);
  return {
    entryId: planning.descriptor.id,
    registryVersion: planning.descriptor.version,
    targetId: planning.targetId,
    configPath: planning.target.configPath,
    serverName: planning.descriptor.server.name,
    definitionSha256: fingerprintNormalizedDefinition(
      definition,
      planning.target.toggleStrategy,
    ),
    targetContractVersion: planning.target.targetContractVersion,
    toggleStrategy: planning.target.toggleStrategy,
    adopted: plan.action === "adopt",
    installedAt: occurredAt,
    updatedAt: occurredAt,
  };
}

function updatedInstallation(
  installation: ManagedInstallation,
  suspendedDescriptor: ManagedInstallation["suspendedDescriptor"],
  occurredAt: string,
): ManagedInstallation {
  return {
    entryId: installation.entryId,
    registryVersion: installation.registryVersion,
    targetId: installation.targetId,
    configPath: installation.configPath,
    serverName: installation.serverName,
    definitionSha256: installation.definitionSha256,
    targetContractVersion: installation.targetContractVersion,
    toggleStrategy: installation.toggleStrategy,
    ...(suspendedDescriptor === undefined ? {} : { suspendedDescriptor }),
    adopted: installation.adopted,
    installedAt: installation.installedAt,
    updatedAt: occurredAt,
  };
}

function applyUpdate(
  plan: Extract<InstallerActionPlan, { readonly outcome: "write" }>,
  planning: OwnershipPlanningInput,
  adapter: TargetAdapter,
  installation: ManagedInstallation,
  occurredAt: string,
): {
  readonly installation: ManagedInstallation;
  readonly restoreDefinition?: Readonly<Record<string, unknown>>;
} {
  if (
    plan.stateEffect !== "update" ||
    (plan.action !== "enable" && plan.action !== "disable")
  ) {
    return invalidState();
  }
  if (!isInstallerTimestampAfter(occurredAt, installation.updatedAt)) {
    return invalidState();
  }
  if (planning.target.toggleStrategy !== "detached") {
    if (plan.definitionSource !== "managed") return invalidState();
    return {
      installation: updatedInstallation(installation, undefined, occurredAt),
    };
  }

  if (plan.action === "disable") {
    if (
      plan.definitionSource !== "managed" ||
      planning.currentServer.kind !== "present" ||
      installation.suspendedDescriptor !== undefined
    ) {
      return invalidState();
    }
    const suspendedDescriptor = adapter.definitionToSuspendedDescriptor(
      installation.serverName,
      planning.currentServer.definition,
    );
    return {
      installation: updatedInstallation(
        installation,
        suspendedDescriptor,
        occurredAt,
      ),
    };
  }

  if (
    plan.definitionSource !== "suspended" ||
    installation.suspendedDescriptor === undefined
  ) {
    return invalidState();
  }
  const restoreDefinition = adapter.suspendedDescriptorToDefinition(
    installation.suspendedDescriptor,
  );
  if (
    fingerprintNormalizedDefinition(restoreDefinition, "detached") !==
    installation.definitionSha256
  ) {
    return invalidState();
  }
  return {
    installation: updatedInstallation(installation, undefined, occurredAt),
    restoreDefinition,
  };
}

function assertAdapterContract(input: ApplyInstallerStatePlanInput): void {
  const { adapter, planning, targetContracts } = input;
  const contract = targetContracts[planning.targetId];
  if (
    contract === undefined ||
    contract.configPath !== planning.target.configPath ||
    contract.targetContractVersion !== planning.target.targetContractVersion ||
    contract.toggleStrategy !== planning.target.toggleStrategy ||
    adapter.metadata.targetId !== planning.targetId ||
    adapter.metadata.targetContractVersion !==
      planning.target.targetContractVersion ||
    adapter.metadata.toggleStrategy !== planning.target.toggleStrategy
  ) {
    invalidState();
  }
}

export function applyInstallerStatePlan(
  input: ApplyInstallerStatePlanInput,
): InstallerStateWriteTransition | undefined {
  assertAdapterContract(input);
  const expectedPlan = planInstallerAction(input.planning, input.plan.action);
  if (!plansMatch(expectedPlan, input.plan)) return invalidState();
  if (input.plan.outcome !== "write") return undefined;

  const key = installationKey(
    input.planning.descriptor.id,
    input.planning.targetId,
    input.planning.target.configPath,
  );
  const currentInstallation = input.planning.state.installations[key];
  let nextInstallation: ManagedInstallation;
  let restoreDefinition: Readonly<Record<string, unknown>> | undefined;
  if (input.plan.stateEffect === "create") {
    if (currentInstallation !== undefined) return invalidState();
    nextInstallation = createInstallation(
      input.plan,
      input.planning,
      input.occurredAt,
    );
  } else {
    if (currentInstallation === undefined) return invalidState();
    const update = applyUpdate(
      input.plan,
      input.planning,
      input.adapter,
      currentInstallation,
      input.occurredAt,
    );
    nextInstallation = update.installation;
    restoreDefinition = update.restoreDefinition;
  }

  const normalized = normalizeAndSerializeInstallerState(
    {
      schemaVersion: 1,
      installations: {
        ...input.planning.state.installations,
        [key]: nextInstallation,
      },
    },
    input.targetContracts,
  );
  const installation = normalized.state.installations[key];
  if (installation === undefined) return invalidState();
  return Object.freeze({
    state: normalized.state,
    bytes: normalized.bytes,
    installation,
    ...(restoreDefinition === undefined ? {} : { restoreDefinition }),
  });
}
