import { describe, expect, it } from "vitest";

import { InstallerError } from "../src/installer-error.js";
import {
  createEmptyInstallerState,
  installationKey,
  type InstallerState,
  type ManagedInstallation,
  type StateTargetContracts,
} from "../src/installer-state.js";
import {
  applyInstallerStatePlan,
  serializeInstallerState,
} from "../src/installer-state-transition.js";
import { fingerprintNormalizedDefinition } from "../src/jcs-fingerprint.js";
import {
  type OwnershipPlanningInput,
  planInstallerAction,
} from "../src/ownership-planner.js";
import {
  type CapabilityInstallDescriptor,
  configurationTargetIds,
  type ConfigurationTargetId,
} from "../src/registry.js";
import { configurationTargetAdapters } from "../src/target-adapters.js";

const decoder = new TextDecoder();
const stateByteLimit = 16_777_216;
const occurredAt = "2026-07-28T15:00:00.123456789Z";

const targetPaths = Object.freeze(
  Object.fromEntries(
    configurationTargetIds.map((targetId) => [
      targetId,
      `/home/tester/config/${targetId}.json`,
    ]),
  ) as Record<ConfigurationTargetId, string>,
);

const targetContracts = Object.freeze(
  Object.fromEntries(
    configurationTargetIds.map((targetId) => {
      const metadata = configurationTargetAdapters[targetId].metadata;
      return [
        targetId,
        Object.freeze({
          configPath: targetPaths[targetId],
          targetContractVersion: metadata.targetContractVersion,
          toggleStrategy: metadata.toggleStrategy,
        }),
      ];
    }),
  ) as unknown as StateTargetContracts,
);

function descriptor(
  version = "2.0.0",
  command = "support-engine-mcp-v2",
): CapabilityInstallDescriptor {
  return {
    id: "support-engine",
    version,
    title: "Support Engine",
    description: "Support tools.",
    capabilityIds: ["support.classify"],
    server: {
      name: "invokta-support",
      transport: {
        type: "stdio",
        command,
        args: ["serve", "--stdio"],
        forwardEnv: ["SUPPORT_API_TOKEN"],
      },
    },
  };
}

function planningInput(
  targetId: ConfigurationTargetId,
  selected: CapabilityInstallDescriptor,
  state: InstallerState,
  currentServer: OwnershipPlanningInput["currentServer"],
  registryDefinition = configurationTargetAdapters[
    targetId
  ].descriptorToDefinition(selected),
): OwnershipPlanningInput {
  const adapter = configurationTargetAdapters[targetId];
  const suspendedDescriptor = Object.values(state.installations)[0]
    ?.suspendedDescriptor;
  return {
    descriptor: selected,
    targetId,
    target: targetContracts[targetId],
    state,
    registryDefinition,
    ...(currentServer.kind === "absent" &&
    adapter.metadata.toggleStrategy === "detached" &&
    suspendedDescriptor !== undefined
      ? {
          normalizedSuspendedDefinition:
            adapter.suspendedDescriptorToDefinition(suspendedDescriptor),
        }
      : {}),
    currentServer,
  };
}

function managedState(
  targetId: ConfigurationTargetId,
  selected: CapabilityInstallDescriptor,
  installedDefinition: Readonly<Record<string, unknown>>,
  overrides: Partial<ManagedInstallation> = {},
): InstallerState {
  const contract = targetContracts[targetId];
  const installation: ManagedInstallation = {
    entryId: selected.id,
    registryVersion: "1.0.0",
    targetId,
    configPath: contract.configPath,
    serverName: selected.server.name,
    definitionSha256: fingerprintNormalizedDefinition(
      installedDefinition,
      contract.toggleStrategy,
    ),
    targetContractVersion: 1,
    toggleStrategy: contract.toggleStrategy,
    adopted: false,
    installedAt: "2026-07-28T12:00:00.000Z",
    updatedAt: "2026-07-28T12:00:00.000Z",
    ...overrides,
  };
  return {
    schemaVersion: 1,
    installations: {
      [installationKey(selected.id, targetId, contract.configPath)]:
        installation,
    },
  };
}

function transition(
  planning: OwnershipPlanningInput,
  action: "install" | "adopt" | "enable" | "disable",
  timestamp = occurredAt,
) {
  return applyInstallerStatePlan({
    adapter: configurationTargetAdapters[planning.targetId],
    occurredAt: timestamp,
    plan: planInstallerAction(planning, action),
    planning,
    targetContracts,
  });
}

function expectStateInvalid(action: () => unknown): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(InstallerError);
    expect((error as InstallerError).code).toBe("STATE_INVALID");
    return;
  }
  throw new Error("Expected STATE_INVALID.");
}

function firstInstallation(state: InstallerState): ManagedInstallation {
  const installation = Object.values(state.installations)[0];
  if (installation === undefined) throw new Error("Expected installation.");
  return installation;
}

describe("immutable installer state transitions", () => {
  it.each(["install", "adopt"] as const)(
    "%s creates one record with exact first-write timestamps",
    (action) => {
      const targetId = "codex";
      const selected = descriptor();
      const adapter = configurationTargetAdapters[targetId];
      const definition = adapter.descriptorToDefinition(selected);
      const planning = planningInput(
        targetId,
        selected,
        createEmptyInstallerState(),
        action === "install"
          ? { kind: "absent" }
          : { kind: "present", definition },
      );

      const result = transition(planning, action);

      expect(result).toBeDefined();
      if (result === undefined) throw new Error("Expected state transition.");
      expect(result.installation).toMatchObject({
        adopted: action === "adopt",
        installedAt: occurredAt,
        updatedAt: occurredAt,
        registryVersion: selected.version,
        definitionSha256: fingerprintNormalizedDefinition(
          definition,
          "native-enabled",
        ),
      });
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.state)).toBe(true);
      expect(Object.isFrozen(result.state.installations)).toBe(true);
      expect(result.bytes.at(-1)).toBe(0x0a);
    },
  );

  it("applies outdated native toggles without changing installed ownership identity", () => {
    const targetId = "codex";
    const oldDescriptor = descriptor("1.0.0", "support-engine-mcp-v1");
    const currentDescriptor = descriptor("2.0.0", "support-engine-mcp-v2");
    const adapter = configurationTargetAdapters[targetId];
    const oldEnabled = adapter.descriptorToDefinition(oldDescriptor);
    const initial = managedState(targetId, currentDescriptor, oldEnabled, {
      adopted: true,
    });
    const before = firstInstallation(initial);
    const disablePlanning = planningInput(
      targetId,
      currentDescriptor,
      initial,
      { kind: "present", definition: oldEnabled },
    );
    expect(planInstallerAction(disablePlanning, "disable")).toMatchObject({
      outcome: "write",
      stateEffect: "update",
      definitionSource: "managed",
    });

    const disabled = transition(disablePlanning, "disable");
    expect(disabled).toBeDefined();
    if (disabled === undefined) throw new Error("Expected disable transition.");
    expect(disabled.installation).toEqual({
      ...before,
      updatedAt: occurredAt,
    });

    const disabledDefinition = {
      ...oldEnabled,
      enabled: false,
    };
    const enablePlanning = planningInput(
      targetId,
      currentDescriptor,
      disabled.state,
      { kind: "present", definition: disabledDefinition },
    );
    const enabled = transition(
      enablePlanning,
      "enable",
      "2026-07-28T16:00:00.000Z",
    );
    expect(enabled).toBeDefined();
    if (enabled === undefined) throw new Error("Expected enable transition.");
    expect(enabled.installation).toEqual({
      ...before,
      updatedAt: "2026-07-28T16:00:00.000Z",
    });
  });

  it("snapshots and restores the historical detached descriptor", () => {
    const targetId = "cursor";
    const oldDescriptor = descriptor("1.0.0", "support-engine-mcp-v1");
    const currentDescriptor = descriptor("2.0.0", "support-engine-mcp-v2");
    const adapter = configurationTargetAdapters[targetId];
    const oldInstalledDefinition =
      adapter.descriptorToDefinition(oldDescriptor);
    const initial = managedState(
      targetId,
      currentDescriptor,
      oldInstalledDefinition,
    );
    const before = firstInstallation(initial);
    const disablePlanning = planningInput(
      targetId,
      currentDescriptor,
      initial,
      { kind: "present", definition: oldInstalledDefinition },
    );

    const disabled = transition(disablePlanning, "disable");
    expect(disabled).toBeDefined();
    if (disabled === undefined) throw new Error("Expected disable transition.");
    expect(disabled.installation).toEqual({
      ...before,
      suspendedDescriptor: oldDescriptor.server,
      updatedAt: occurredAt,
    });
    expect(disabled.restoreDefinition).toBeUndefined();

    const enablePlanning = planningInput(
      targetId,
      currentDescriptor,
      disabled.state,
      { kind: "absent" },
    );
    expect(planInstallerAction(enablePlanning, "enable")).toMatchObject({
      outcome: "write",
      configEffect: "restore",
      definitionSource: "suspended",
    });
    const enabled = transition(
      enablePlanning,
      "enable",
      "2026-07-28T16:00:00.000Z",
    );
    expect(enabled).toBeDefined();
    if (enabled === undefined) throw new Error("Expected enable transition.");
    expect(enabled.restoreDefinition).toEqual(oldInstalledDefinition);
    expect(enabled.installation).toEqual({
      ...before,
      updatedAt: "2026-07-28T16:00:00.000Z",
    });
    expect(enabled.installation.suspendedDescriptor).toBeUndefined();
  });

  it("returns no state transition for an idempotent plan", () => {
    const targetId = "codex";
    const selected = descriptor();
    const definition =
      configurationTargetAdapters[targetId].descriptorToDefinition(selected);
    const state = managedState(targetId, selected, definition);
    const planning = planningInput(targetId, selected, state, {
      kind: "present",
      definition,
    });

    expect(planInstallerAction(planning, "enable").outcome).toBe("unchanged");
    expect(transition(planning, "enable")).toBeUndefined();
  });

  it("rejects invalid or backwards transition timestamps", () => {
    const targetId = "codex";
    const selected = descriptor();
    const definition =
      configurationTargetAdapters[targetId].descriptorToDefinition(selected);
    const emptyPlanning = planningInput(
      targetId,
      selected,
      createEmptyInstallerState(),
      { kind: "absent" },
    );
    expectStateInvalid(() => transition(emptyPlanning, "install", "not-time"));

    const state = managedState(targetId, selected, definition);
    const disablePlanning = planningInput(targetId, selected, state, {
      kind: "present",
      definition,
    });
    expectStateInvalid(() =>
      transition(disablePlanning, "disable", "2026-07-28T11:59:59.999Z"),
    );
    expectStateInvalid(() =>
      transition(disablePlanning, "disable", "2026-07-28T12:00:00.000Z"),
    );
  });

  it.each([
    ["native", "codex"],
    ["detached", "cursor"],
  ] as const)(
    "requires a strictly increasing timestamp for a real %s toggle",
    (_strategy, targetId) => {
      const selected = descriptor();
      const adapter = configurationTargetAdapters[targetId];
      const definition = adapter.descriptorToDefinition(selected);
      const state = managedState(targetId, selected, definition, {
        updatedAt: "2026-07-28T14:00:00.123456789Z",
      });
      const planning = planningInput(targetId, selected, state, {
        kind: "present",
        definition,
      });

      for (const timestamp of [
        "2026-07-28T14:00:00.123456789Z",
        "2026-07-28T14:00:00.123456788Z",
      ]) {
        expectStateInvalid(() => transition(planning, "disable", timestamp));
      }
    },
  );
});

function orderedState(reverse: boolean): InstallerState {
  const first = managedState(
    "codex",
    descriptor("1.0.0", "first"),
    configurationTargetAdapters.codex.descriptorToDefinition(
      descriptor("1.0.0", "first"),
    ),
  );
  const secondDescriptor = {
    ...descriptor("1.0.0", "second"),
    id: "another-engine",
    server: {
      ...descriptor("1.0.0", "second").server,
      name: "another-server",
    },
  };
  const second = managedState(
    "hermes",
    secondDescriptor,
    configurationTargetAdapters.hermes.descriptorToDefinition(secondDescriptor),
  );
  const entries = [
    ...Object.entries(first.installations),
    ...Object.entries(second.installations),
  ];
  return {
    schemaVersion: 1,
    installations: Object.fromEntries(reverse ? entries.reverse() : entries),
  };
}

function boundaryState(recordCount: number): InstallerState {
  const installations: Record<string, ManagedInstallation> = {};
  for (let index = 0; index < recordCount; index += 1) {
    const targetId =
      configurationTargetIds[index % configurationTargetIds.length];
    if (targetId === undefined) throw new Error("Expected target ID.");
    const entryId = `engine-${Math.floor(index / configurationTargetIds.length)
      .toString()
      .padStart(4, "0")}`;
    const record: ManagedInstallation = {
      entryId,
      registryVersion: "v",
      targetId,
      configPath: targetContracts[targetId].configPath,
      serverName: `server-${Math.floor(index / configurationTargetIds.length)
        .toString()
        .padStart(4, "0")}`,
      definitionSha256: "a".repeat(64),
      targetContractVersion: 1,
      toggleStrategy: targetContracts[targetId].toggleStrategy,
      adopted: false,
      installedAt: "2026-07-28T12:00:00.000Z",
      updatedAt: "2026-07-28T12:00:00.000Z",
    };
    installations[
      installationKey(entryId, targetId, targetContracts[targetId].configPath)
    ] = record;
  }
  return { schemaVersion: 1, installations };
}

function withVersionPadding(
  state: InstallerState,
  totalPadding: number,
): InstallerState {
  const entries = Object.entries(state.installations);
  const installations: Record<string, ManagedInstallation> = {};
  let remaining = totalPadding;
  for (const [key, installation] of entries) {
    const padding = Math.min(4_095, remaining);
    remaining -= padding;
    installations[key] = {
      ...installation,
      registryVersion: `${installation.registryVersion}${"x".repeat(padding)}`,
    };
  }
  if (remaining !== 0)
    throw new Error("Insufficient boundary padding capacity.");
  return { schemaVersion: 1, installations };
}

describe("deterministic installer state serialization", () => {
  it("sorts tuple keys, appends one LF, and does not mutate its input", () => {
    const forward = orderedState(false);
    const reverse = orderedState(true);

    const forwardBytes = serializeInstallerState(forward, targetContracts);
    const reverseBytes = serializeInstallerState(reverse, targetContracts);

    expect(forwardBytes).toEqual(reverseBytes);
    expect(decoder.decode(forwardBytes).endsWith("\n")).toBe(true);
    expect(decoder.decode(forwardBytes).endsWith("\n\n")).toBe(false);
    expect(Object.isFrozen(reverse)).toBe(false);
    expect(Object.isFrozen(reverse.installations)).toBe(false);
  });

  it("accepts exactly 9,000 records and 16,777,216 bytes, then rejects either successor", () => {
    const base = boundaryState(9_000);
    const baseBytes = serializeInstallerState(base, targetContracts);
    const exact = withVersionPadding(
      base,
      stateByteLimit - baseBytes.byteLength,
    );
    const exactBytes = serializeInstallerState(exact, targetContracts);

    expect(Object.keys(exact.installations)).toHaveLength(9_000);
    expect(exactBytes.byteLength).toBe(stateByteLimit);

    const firstEntry = Object.entries(exact.installations)[0];
    if (firstEntry === undefined) throw new Error("Expected installation.");
    const [firstKey, first] = firstEntry;
    expectStateInvalid(() =>
      serializeInstallerState(
        {
          schemaVersion: 1,
          installations: {
            ...exact.installations,
            [firstKey]: {
              ...first,
              registryVersion: `${first.registryVersion}x`,
            },
          },
        },
        targetContracts,
      ),
    );
    expectStateInvalid(() =>
      serializeInstallerState(boundaryState(9_001), targetContracts),
    );
  }, 60_000);
});
