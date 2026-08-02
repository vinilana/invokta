import type {
  CapabilityInstallDescriptor,
  ConfigurationTargetId,
  ExecutableResolver,
  HarnessDetectionSnapshot,
} from "@invokta/client-config";
import {
  InstallerError,
  installDescriptorAcrossTargets,
  installerErrorMessages,
  type MutationCoordinatorDependencies,
  resolveRuntimeRequirements,
} from "@invokta/client-config";
import type { InteractivePrompter } from "./interactive-prompter.js";
import type { InstallerExitCode } from "./run-installer-cli.js";

export interface RunInstallSessionOptions {
  readonly dependencies: MutationCoordinatorDependencies;
  readonly descriptor: CapabilityInstallDescriptor;
  readonly prompter: InteractivePrompter;
  readonly resolveExecutable: ExecutableResolver;
  readonly snapshot: HarnessDetectionSnapshot;
}

function cancelled(prompter: InteractivePrompter): 130 {
  prompter.cancel(installerErrorMessages.CANCELLED);
  return 130;
}

export async function runInstallSession(
  options: RunInstallSessionOptions,
): Promise<InstallerExitCode> {
  const ready = await resolveRuntimeRequirements({
    action: "install",
    descriptor: options.descriptor.server,
    resolveExecutable: options.resolveExecutable,
    environment: options.dependencies.environment,
  });
  if (ready.kind === "blocked") throw new InstallerError(ready.code);

  const targets = options.snapshot.targets.filter(
    (target) =>
      target.eligible &&
      target.configuration.kind !== "blocked" &&
      options.dependencies.adapters[target.id].compatibility(options.descriptor)
        .supported,
  );
  if (targets.length === 0) throw new InstallerError("NO_SUPPORTED_HARNESS");
  const targetIds = targets.map(({ id }) => id);
  const selection = await options.prompter.multiselect<ConfigurationTargetId>({
    message: `Install ${options.descriptor.title} in which MCP clients?`,
    options: targets.map((target) => ({
      value: target.id,
      label: target.displayName,
      hint: target.evidence,
    })),
    initialValues: targetIds,
  });
  if (selection.kind === "cancelled") return cancelled(options.prompter);
  if (selection.value.length === 0) {
    options.prompter.outro("No changes were made.");
    return 0;
  }
  const confirmed = await options.prompter.confirm(
    `Update ${String(selection.value.length)} MCP client configuration${selection.value.length === 1 ? "" : "s"}?`,
  );
  if (confirmed.kind === "cancelled") return cancelled(options.prompter);
  if (!confirmed.value) {
    options.prompter.outro("No changes were made.");
    return 0;
  }

  const results = await installDescriptorAcrossTargets({
    dependencies: options.dependencies,
    descriptor: options.descriptor,
    snapshot: options.snapshot,
    targetIds: selection.value,
  });
  let failed = false;
  for (const result of results) {
    const target = targets.find(({ id }) => id === result.targetId);
    const name = target?.displayName ?? result.targetId;
    if (result.outcome === "failed") {
      failed = true;
      options.prompter.log(
        "error",
        `${name}: ${result.code}: ${installerErrorMessages[result.code]}`,
      );
    } else {
      options.prompter.log(
        "success",
        `${name}: ${result.outcome === "installed" ? "installed" : "already installed"}.`,
      );
    }
  }
  options.prompter.outro(
    failed
      ? "Installation completed with errors."
      : "Action Engine installed. Restart or reload the selected MCP clients.",
  );
  return failed ? 1 : 0;
}
