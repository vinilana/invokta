import { describe, expect, it } from "vitest";
import {
  createEmptyInstallerState,
  type InstallerState,
  installationKey,
  type ManagedInstallation,
  type StateTargetContract,
} from "../src/installer-state.js";
import { fingerprintNormalizedDefinition } from "../src/jcs-fingerprint.js";
import {
  type OwnershipPlanningInput,
  planInstallerAction,
  planOwnership,
} from "../src/ownership-planner.js";
import type { CapabilityInstallDescriptor } from "../src/registry.js";

const secretSentinel = "PLANNER_SECRET_SENTINEL_a5cd27";
const strategyCases = [
  ["native-enabled" as const, "codex" as const],
  ["native-disabled" as const, "antigravity" as const],
  ["detached" as const, "cursor" as const],
] as const;
const descriptor: CapabilityInstallDescriptor = {
  id: "support-engine",
  version: "2.0.0",
  title: "Support Engine",
  description: "Support tools.",
  capabilityIds: ["support.classify"],
  server: {
    name: "invokta-support",
    transport: {
      type: "stdio",
      command: "support-engine-mcp",
      args: [],
      forwardEnv: [],
    },
  },
};

function target(
  toggleStrategy: StateTargetContract["toggleStrategy"] = "native-enabled",
): StateTargetContract {
  return {
    configPath: "/home/tester/.agent/config.json",
    targetContractVersion: 1,
    toggleStrategy,
  };
}

function normalizedDefinition(
  toggleStrategy: StateTargetContract["toggleStrategy"],
  enabled = true,
  command = "support-engine-mcp",
) {
  return {
    type: "stdio",
    command,
    args: [],
    ...(toggleStrategy === "native-enabled" ? { enabled } : {}),
    ...(toggleStrategy === "native-disabled" ? { disabled: !enabled } : {}),
  };
}

function managedState(
  targetId: "codex" | "antigravity" | "cursor",
  contract: StateTargetContract,
  definition: Readonly<Record<string, unknown>>,
  overrides: Partial<ManagedInstallation> = {},
): InstallerState {
  const installation: ManagedInstallation = {
    entryId: descriptor.id,
    registryVersion: "1.0.0",
    targetId,
    configPath: contract.configPath,
    serverName: descriptor.server.name,
    definitionSha256: fingerprintNormalizedDefinition(
      definition,
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
      [installationKey(
        installation.entryId,
        installation.targetId,
        installation.configPath,
      )]: installation,
    },
  };
}

function input(
  overrides: Partial<OwnershipPlanningInput> = {},
): OwnershipPlanningInput {
  const contract = target();
  return {
    currentServer: { kind: "absent" },
    descriptor,
    registryDefinition: normalizedDefinition(contract.toggleStrategy),
    state: createEmptyInstallerState(),
    target: contract,
    targetId: "codex",
    ...overrides,
  };
}

describe("pure installer ownership planning", () => {
  it("plans available installation and exact external adoption without config replacement", () => {
    const registryDefinition = normalizedDefinition("native-enabled");

    expect(planOwnership(input({ registryDefinition }))).toEqual({
      status: "available",
      actions: ["install"],
    });
    expect(
      planInstallerAction(input({ registryDefinition }), "install"),
    ).toEqual({
      outcome: "write",
      action: "install",
      configEffect: "install",
      stateEffect: "create",
      definitionSource: "registry",
    });

    const externalInput = input({
      currentServer: { kind: "present", definition: registryDefinition },
      registryDefinition,
    });
    expect(planOwnership(externalInput)).toEqual({
      status: "external",
      actions: ["adopt"],
    });
    expect(planInstallerAction(externalInput, "adopt")).toEqual({
      outcome: "write",
      action: "adopt",
      configEffect: "none",
      stateEffect: "create",
      definitionSource: "current",
    });
  });

  it.each(strategyCases)(
    "offers exact external %s definitions adoption only",
    (toggleStrategy, targetId) => {
      const contract = target(toggleStrategy);
      const definition = normalizedDefinition(toggleStrategy);
      const planningInput = input({
        currentServer: { kind: "present", definition },
        registryDefinition: definition,
        target: contract,
        targetId,
      });

      expect(planOwnership(planningInput)).toEqual({
        status: "external",
        actions: ["adopt"],
      });
      expect(planInstallerAction(planningInput, "adopt")).toMatchObject({
        outcome: "write",
        configEffect: "none",
        stateEffect: "create",
      });
    },
  );

  it("classifies a different external definition as conflict without exposing it", () => {
    const planningInput = input({
      currentServer: {
        kind: "present",
        definition: normalizedDefinition(
          "native-enabled",
          true,
          secretSentinel,
        ),
      },
    });

    const ownership = planOwnership(planningInput);
    const action = planInstallerAction(planningInput, "install");

    expect(ownership).toEqual({ status: "conflict", actions: [] });
    expect(action).toEqual({
      outcome: "blocked",
      action: "install",
      code: "CONFIG_CONFLICT",
      configEffect: "none",
      stateEffect: "none",
    });
    expect(JSON.stringify({ ownership, action })).not.toContain(secretSentinel);
  });

  it.each(strategyCases)(
    "classifies ordinary %s managed enablement and inverse actions",
    (toggleStrategy, targetId) => {
      const contract = target(toggleStrategy);
      const enabledDefinition = normalizedDefinition(toggleStrategy, true);
      const disabledDefinition = normalizedDefinition(toggleStrategy, false);
      const enabledInput = input({
        currentServer: { kind: "present", definition: enabledDefinition },
        registryDefinition: enabledDefinition,
        state: managedState(targetId, contract, enabledDefinition),
        target: contract,
        targetId,
      });
      const disabledInput = input({
        currentServer:
          toggleStrategy === "detached"
            ? { kind: "absent" }
            : { kind: "present", definition: disabledDefinition },
        registryDefinition: enabledDefinition,
        state: managedState(targetId, contract, disabledDefinition, {
          ...(toggleStrategy === "detached"
            ? {
                suspendedDescriptor: {
                  name: descriptor.server.name,
                  transport: descriptor.server.transport,
                },
              }
            : {}),
        }),
        ...(toggleStrategy === "detached"
          ? { normalizedSuspendedDefinition: disabledDefinition }
          : {}),
        target: contract,
        targetId,
      });

      expect(planOwnership(enabledInput)).toEqual({
        status: "enabled",
        actions: ["disable"],
      });
      expect(planOwnership(disabledInput)).toEqual({
        status: "disabled",
        actions: ["enable"],
      });
    },
  );

  it.each(strategyCases)(
    "makes repeated install, enable, and disable no-write plans for %s",
    (toggleStrategy, targetId) => {
      const contract = target(toggleStrategy);
      const enabledDefinition = normalizedDefinition(toggleStrategy, true);
      const disabledDefinition = normalizedDefinition(toggleStrategy, false);
      const enabledInput = input({
        currentServer: { kind: "present", definition: enabledDefinition },
        registryDefinition: enabledDefinition,
        state: managedState(targetId, contract, enabledDefinition),
        target: contract,
        targetId,
      });
      const disabledInput = input({
        currentServer:
          toggleStrategy === "detached"
            ? { kind: "absent" }
            : { kind: "present", definition: disabledDefinition },
        registryDefinition: enabledDefinition,
        state: managedState(targetId, contract, disabledDefinition, {
          ...(toggleStrategy === "detached"
            ? {
                suspendedDescriptor: {
                  name: descriptor.server.name,
                  transport: descriptor.server.transport,
                },
              }
            : {}),
        }),
        ...(toggleStrategy === "detached"
          ? { normalizedSuspendedDefinition: disabledDefinition }
          : {}),
        target: contract,
        targetId,
      });

      for (const [action, planningInput] of [
        ["install", enabledInput],
        ["enable", enabledInput],
        ["disable", disabledInput],
      ] as const) {
        expect(planInstallerAction(planningInput, action)).toEqual({
          outcome: "unchanged",
          action,
          configEffect: "none",
          stateEffect: "none",
        });
      }
    },
  );

  it("fails managed hash drift closed for enable and disable", () => {
    const contract = target();
    const recordedDefinition = normalizedDefinition(contract.toggleStrategy);
    const planningInput = input({
      currentServer: {
        kind: "present",
        definition: normalizedDefinition(
          contract.toggleStrategy,
          true,
          secretSentinel,
        ),
      },
      state: managedState("codex", contract, recordedDefinition),
      target: contract,
    });

    const ownership = planOwnership(planningInput);
    const enable = planInstallerAction(planningInput, "enable");
    const disable = planInstallerAction(planningInput, "disable");

    expect(ownership).toEqual({ status: "drifted", actions: [] });
    expect(enable).toMatchObject({
      outcome: "blocked",
      code: "CONFIG_DRIFT",
      configEffect: "none",
      stateEffect: "none",
    });
    expect(disable).toMatchObject({
      outcome: "blocked",
      code: "CONFIG_DRIFT",
      configEffect: "none",
      stateEffect: "none",
    });
    expect(JSON.stringify({ ownership, enable, disable })).not.toContain(
      secretSentinel,
    );
  });

  it.each(strategyCases)(
    "fails managed %s current-definition drift closed",
    (toggleStrategy, targetId) => {
      const contract = target(toggleStrategy);
      const recordedDefinition = normalizedDefinition(toggleStrategy);
      const planningInput = input({
        currentServer: {
          kind: "present",
          definition: normalizedDefinition(
            toggleStrategy,
            true,
            secretSentinel,
          ),
        },
        registryDefinition: recordedDefinition,
        state: managedState(targetId, contract, recordedDefinition),
        target: contract,
        targetId,
      });

      const ownership = planOwnership(planningInput);
      const action = planInstallerAction(planningInput, "disable");
      expect(ownership).toEqual({ status: "drifted", actions: [] });
      expect(action).toMatchObject({
        outcome: "blocked",
        code: "CONFIG_DRIFT",
        configEffect: "none",
        stateEffect: "none",
      });
      expect(JSON.stringify({ ownership, action })).not.toContain(
        secretSentinel,
      );
    },
  );

  it("does not mark metadata-only registry version changes as outdated", () => {
    const contract = target();
    const definition = normalizedDefinition(contract.toggleStrategy);
    const planningInput = input({
      currentServer: { kind: "present", definition },
      state: managedState("codex", contract, definition),
      target: contract,
    });

    expect(descriptor.version).toBe("2.0.0");
    expect(planOwnership(planningInput)).toEqual({
      status: "enabled",
      actions: ["disable"],
    });
  });

  it.each(strategyCases)(
    "keeps an outdated %s installed definition and offers only the inverse action",
    (toggleStrategy, targetId) => {
      const contract = target(toggleStrategy);
      const oldDefinition = normalizedDefinition(
        toggleStrategy,
        true,
        "old-mcp",
      );
      const newDefinition = normalizedDefinition(
        toggleStrategy,
        true,
        "new-mcp",
      );
      const planningInput = input({
        currentServer: { kind: "present", definition: oldDefinition },
        registryDefinition: newDefinition,
        state: managedState(targetId, contract, oldDefinition),
        target: contract,
        targetId,
      });

      expect(planOwnership(planningInput)).toEqual({
        status: "outdated",
        enablement: "enabled",
        actions: ["disable"],
      });
      expect(planInstallerAction(planningInput, "install")).toEqual({
        outcome: "write",
        action: "install",
        configEffect: "replace",
        stateEffect: "update",
        definitionSource: "registry",
      });
      expect(planInstallerAction(planningInput, "disable")).toEqual({
        outcome: "write",
        action: "disable",
        configEffect: toggleStrategy === "detached" ? "detach" : "set-disabled",
        stateEffect: "update",
        definitionSource: "managed",
      });
    },
  );

  it.each(strategyCases)(
    "keeps an outdated disabled %s definition and offers only enable",
    (toggleStrategy, targetId) => {
      const contract = target(toggleStrategy);
      const oldDefinition = normalizedDefinition(
        toggleStrategy,
        false,
        "old-mcp",
      );
      const newDefinition = normalizedDefinition(
        toggleStrategy,
        true,
        "new-mcp",
      );
      const suspendedDescriptor = {
        name: descriptor.server.name,
        transport: { ...descriptor.server.transport, command: "old-mcp" },
      };
      const planningInput = input({
        currentServer:
          toggleStrategy === "detached"
            ? { kind: "absent" }
            : { kind: "present", definition: oldDefinition },
        registryDefinition: newDefinition,
        state: managedState(targetId, contract, oldDefinition, {
          ...(toggleStrategy === "detached" ? { suspendedDescriptor } : {}),
        }),
        ...(toggleStrategy === "detached"
          ? { normalizedSuspendedDefinition: oldDefinition }
          : {}),
        target: contract,
        targetId,
      });

      expect(planOwnership(planningInput)).toEqual({
        status: "outdated",
        enablement: "disabled",
        actions: ["enable"],
      });
      expect(planInstallerAction(planningInput, "install")).toEqual({
        outcome: "write",
        action: "install",
        configEffect:
          toggleStrategy === "detached" ? "none" : "replace-disabled",
        stateEffect: "update",
        definitionSource: "registry",
      });
      expect(planInstallerAction(planningInput, "enable")).toEqual({
        outcome: "write",
        action: "enable",
        configEffect: toggleStrategy === "detached" ? "restore" : "set-enabled",
        stateEffect: "update",
        definitionSource:
          toggleStrategy === "detached" ? "suspended" : "managed",
      });
    },
  );

  it("classifies detached presence/snapshot mismatches as drift", () => {
    const contract = target("detached");
    const definition = normalizedDefinition("detached");
    const absentWithoutSnapshot = input({
      state: managedState("cursor", contract, definition),
      target: contract,
      targetId: "cursor",
    });
    const presentWithSnapshot = input({
      currentServer: { kind: "present", definition },
      state: managedState("cursor", contract, definition, {
        suspendedDescriptor: {
          name: descriptor.server.name,
          transport: descriptor.server.transport,
        },
      }),
      target: contract,
      targetId: "cursor",
    });

    expect(planOwnership(absentWithoutSnapshot)).toEqual({
      status: "drifted",
      actions: [],
    });
    expect(planOwnership(presentWithSnapshot)).toEqual({
      status: "drifted",
      actions: [],
    });
  });

  it("requires fingerprint proof before restoring a detached suspended descriptor", () => {
    const contract = target("detached");
    const recordedDefinition = normalizedDefinition(
      "detached",
      false,
      "old-mcp",
    );
    const suspendedDescriptor = {
      name: descriptor.server.name,
      transport: { ...descriptor.server.transport, command: "old-mcp" },
    };
    const base = {
      currentServer: { kind: "absent" as const },
      registryDefinition: recordedDefinition,
      state: managedState("cursor", contract, recordedDefinition, {
        suspendedDescriptor,
      }),
      target: contract,
      targetId: "cursor" as const,
    };
    const missingProof = input(base);
    const mismatchedProof = input({
      ...base,
      normalizedSuspendedDefinition: normalizedDefinition(
        "detached",
        false,
        secretSentinel,
      ),
    });

    for (const planningInput of [missingProof, mismatchedProof]) {
      const ownership = planOwnership(planningInput);
      const action = planInstallerAction(planningInput, "enable");
      expect(ownership).toEqual({ status: "drifted", actions: [] });
      expect(action).toMatchObject({
        outcome: "blocked",
        code: "CONFIG_DRIFT",
        configEffect: "none",
        stateEffect: "none",
      });
      expect(JSON.stringify({ ownership, action })).not.toContain(
        secretSentinel,
      );
    }
  });

  it("treats a missing managed native entry as drift", () => {
    const contract = target();
    const definition = normalizedDefinition(contract.toggleStrategy);
    const planningInput = input({
      state: managedState("codex", contract, definition),
      target: contract,
    });

    expect(planOwnership(planningInput)).toEqual({
      status: "drifted",
      actions: [],
    });
  });
});
