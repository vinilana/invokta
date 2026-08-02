import { InstallerError } from "./installer-error.js";
import {
  type InstallerState,
  installationKey,
  type ManagedInstallation,
  type StateTargetContract,
} from "./installer-state.js";
import { fingerprintNormalizedDefinition } from "./jcs-fingerprint.js";
import type {
  CapabilityInstallDescriptor,
  ConfigurationTargetId,
} from "./registry.js";

export type InstallerAction = "install" | "enable" | "disable" | "adopt";

export interface OwnershipPlanningInput {
  readonly descriptor: CapabilityInstallDescriptor;
  readonly targetId: ConfigurationTargetId;
  readonly target: StateTargetContract;
  readonly state: InstallerState;
  readonly registryDefinition: Readonly<Record<string, unknown>>;
  readonly normalizedSuspendedDefinition?: Readonly<Record<string, unknown>>;
  readonly currentServer:
    | { readonly kind: "absent" }
    | {
        readonly kind: "present";
        readonly definition: Readonly<Record<string, unknown>>;
      };
}

export type OwnershipPlan =
  | { readonly status: "available"; readonly actions: readonly ["install"] }
  | { readonly status: "external"; readonly actions: readonly ["adopt"] }
  | { readonly status: "conflict"; readonly actions: readonly [] }
  | { readonly status: "drifted"; readonly actions: readonly [] }
  | {
      readonly status: "enabled";
      readonly actions: readonly ["disable"];
    }
  | {
      readonly status: "disabled";
      readonly actions: readonly ["enable"];
    }
  | {
      readonly status: "outdated";
      readonly enablement: "enabled";
      readonly actions: readonly ["disable"];
    }
  | {
      readonly status: "outdated";
      readonly enablement: "disabled";
      readonly actions: readonly ["enable"];
    };

export type InstallerActionPlan =
  | {
      readonly outcome: "unchanged";
      readonly action: InstallerAction;
      readonly configEffect: "none";
      readonly stateEffect: "none";
    }
  | {
      readonly outcome: "blocked";
      readonly action: InstallerAction;
      readonly code: "CONFIG_CONFLICT" | "CONFIG_DRIFT";
      readonly configEffect: "none";
      readonly stateEffect: "none";
    }
  | {
      readonly outcome: "write";
      readonly action: InstallerAction;
      readonly configEffect:
        | "none"
        | "install"
        | "replace"
        | "replace-disabled"
        | "set-enabled"
        | "set-disabled"
        | "detach"
        | "restore";
      readonly stateEffect: "create" | "update";
      readonly definitionSource:
        | "registry"
        | "current"
        | "managed"
        | "suspended";
    };

interface ManagedClassification {
  readonly ownership: OwnershipPlan;
  readonly installation: ManagedInstallation;
  readonly enablement: "enabled" | "disabled";
}

const actions = Object.freeze({
  install: Object.freeze(["install"] as const),
  adopt: Object.freeze(["adopt"] as const),
  enable: Object.freeze(["enable"] as const),
  disable: Object.freeze(["disable"] as const),
  none: Object.freeze([] as const),
});

function freezePlan<const T extends object>(plan: T): Readonly<T> {
  return Object.freeze(plan);
}

function findManagedInstallation(
  input: OwnershipPlanningInput,
): ManagedInstallation | undefined {
  return input.state.installations[
    installationKey(
      input.descriptor.id,
      input.targetId,
      input.target.configPath,
    )
  ];
}

function validateManagedContract(
  input: OwnershipPlanningInput,
  installation: ManagedInstallation,
): void {
  if (
    installation.entryId !== input.descriptor.id ||
    installation.targetId !== input.targetId ||
    installation.configPath !== input.target.configPath ||
    installation.targetContractVersion !== input.target.targetContractVersion ||
    installation.toggleStrategy !== input.target.toggleStrategy
  ) {
    throw new InstallerError("STATE_INVALID");
  }
}

function nativeEnablement(
  definition: Readonly<Record<string, unknown>>,
  field: "enabled" | "disabled",
): "enabled" | "disabled" {
  let property: PropertyDescriptor | undefined;
  try {
    property = Object.getOwnPropertyDescriptor(definition, field);
  } catch (cause) {
    throw new InstallerError("HARNESS_CONFIG_INVALID", cause);
  }
  if (
    property === undefined ||
    !("value" in property) ||
    typeof property.value !== "boolean"
  ) {
    throw new InstallerError("HARNESS_CONFIG_INVALID");
  }
  return field === "enabled"
    ? property.value
      ? "enabled"
      : "disabled"
    : property.value
      ? "disabled"
      : "enabled";
}

function classifyManaged(
  input: OwnershipPlanningInput,
  installation: ManagedInstallation,
): ManagedClassification {
  validateManagedContract(input, installation);
  const strategy = input.target.toggleStrategy;
  let enablement: "enabled" | "disabled";

  if (strategy === "detached") {
    if (input.currentServer.kind === "absent") {
      if (installation.suspendedDescriptor === undefined) {
        return {
          installation,
          enablement: "enabled",
          ownership: freezePlan({ status: "drifted", actions: actions.none }),
        };
      }
      if (
        input.normalizedSuspendedDefinition === undefined ||
        fingerprintNormalizedDefinition(
          input.normalizedSuspendedDefinition,
          "detached",
        ) !== installation.definitionSha256
      ) {
        return {
          installation,
          enablement: "disabled",
          ownership: freezePlan({ status: "drifted", actions: actions.none }),
        };
      }
      enablement = "disabled";
    } else {
      if (installation.suspendedDescriptor !== undefined) {
        return {
          installation,
          enablement: "disabled",
          ownership: freezePlan({ status: "drifted", actions: actions.none }),
        };
      }
      enablement = "enabled";
    }
  } else {
    if (installation.suspendedDescriptor !== undefined) {
      throw new InstallerError("STATE_INVALID");
    }
    if (input.currentServer.kind === "absent") {
      return {
        installation,
        enablement: "enabled",
        ownership: freezePlan({ status: "drifted", actions: actions.none }),
      };
    }
    enablement = nativeEnablement(
      input.currentServer.definition,
      strategy === "native-enabled" ? "enabled" : "disabled",
    );
  }

  if (installation.serverName !== input.descriptor.server.name) {
    return {
      installation,
      enablement,
      ownership: freezePlan({ status: "drifted", actions: actions.none }),
    };
  }
  if (
    input.currentServer.kind === "present" &&
    fingerprintNormalizedDefinition(
      input.currentServer.definition,
      strategy,
    ) !== installation.definitionSha256
  ) {
    return {
      installation,
      enablement,
      ownership: freezePlan({ status: "drifted", actions: actions.none }),
    };
  }

  const registryFingerprint = fingerprintNormalizedDefinition(
    input.registryDefinition,
    strategy,
  );
  const outdated = registryFingerprint !== installation.definitionSha256;
  if (outdated) {
    return {
      installation,
      enablement,
      ownership: freezePlan(
        enablement === "enabled"
          ? {
              status: "outdated",
              enablement: "enabled",
              actions: actions.disable,
            }
          : {
              status: "outdated",
              enablement: "disabled",
              actions: actions.enable,
            },
      ),
    };
  }
  return {
    installation,
    enablement,
    ownership: freezePlan(
      enablement === "enabled"
        ? { status: "enabled", actions: actions.disable }
        : { status: "disabled", actions: actions.enable },
    ),
  };
}

function classify(
  input: OwnershipPlanningInput,
):
  | { readonly kind: "unmanaged"; readonly ownership: OwnershipPlan }
  | ({ readonly kind: "managed" } & ManagedClassification) {
  const installation = findManagedInstallation(input);
  if (installation !== undefined) {
    return {
      kind: "managed",
      ...classifyManaged(input, installation),
    };
  }
  if (input.currentServer.kind === "absent") {
    return {
      kind: "unmanaged",
      ownership: freezePlan({ status: "available", actions: actions.install }),
    };
  }
  const strategy = input.target.toggleStrategy;
  const currentFingerprint = fingerprintNormalizedDefinition(
    input.currentServer.definition,
    strategy,
  );
  const registryFingerprint = fingerprintNormalizedDefinition(
    input.registryDefinition,
    strategy,
  );
  return {
    kind: "unmanaged",
    ownership:
      currentFingerprint === registryFingerprint
        ? freezePlan({ status: "external", actions: actions.adopt })
        : freezePlan({ status: "conflict", actions: actions.none }),
  };
}

export function planOwnership(input: OwnershipPlanningInput): OwnershipPlan {
  return classify(input).ownership;
}

function unchanged(action: InstallerAction): InstallerActionPlan {
  return freezePlan({
    outcome: "unchanged",
    action,
    configEffect: "none",
    stateEffect: "none",
  });
}

function blocked(
  action: InstallerAction,
  code: "CONFIG_CONFLICT" | "CONFIG_DRIFT",
): InstallerActionPlan {
  return freezePlan({
    outcome: "blocked",
    action,
    code,
    configEffect: "none",
    stateEffect: "none",
  });
}

export function planInstallerAction(
  input: OwnershipPlanningInput,
  action: InstallerAction,
): InstallerActionPlan {
  const classification = classify(input);
  const status = classification.ownership.status;
  if (status === "conflict") return blocked(action, "CONFIG_CONFLICT");
  if (status === "drifted") return blocked(action, "CONFIG_DRIFT");

  if (status === "available") {
    return action === "install"
      ? freezePlan({
          outcome: "write",
          action,
          configEffect: "install",
          stateEffect: "create",
          definitionSource: "registry",
        })
      : unchanged(action);
  }
  if (status === "external") {
    return action === "adopt"
      ? freezePlan({
          outcome: "write",
          action,
          configEffect: "none",
          stateEffect: "create",
          definitionSource: "current",
        })
      : blocked(action, "CONFIG_CONFLICT");
  }

  const enablement =
    status === "outdated"
      ? classification.ownership.enablement
      : status === "enabled"
        ? "enabled"
        : "disabled";
  if (status === "outdated" && action === "install") {
    return freezePlan({
      outcome: "write",
      action,
      configEffect:
        enablement === "enabled"
          ? "replace"
          : input.target.toggleStrategy === "detached"
            ? "none"
            : "replace-disabled",
      stateEffect: "update",
      definitionSource: "registry",
    });
  }
  if (
    action === "adopt" ||
    action === "install" ||
    (action === "enable" && enablement === "enabled") ||
    (action === "disable" && enablement === "disabled")
  ) {
    return unchanged(action);
  }

  const strategy = input.target.toggleStrategy;
  if (action === "disable" && enablement === "enabled") {
    return freezePlan({
      outcome: "write",
      action,
      configEffect: strategy === "detached" ? "detach" : "set-disabled",
      stateEffect: "update",
      definitionSource: "managed",
    });
  }
  if (action === "enable" && enablement === "disabled") {
    return freezePlan({
      outcome: "write",
      action,
      configEffect: strategy === "detached" ? "restore" : "set-enabled",
      stateEffect: "update",
      definitionSource: strategy === "detached" ? "suspended" : "managed",
    });
  }
  return unchanged(action);
}
