import type {
  ExecutableResolver,
  HarnessDetectionSnapshot,
} from "./harness-detection.js";
import { InstallerError, installerErrorMessages } from "./installer-error.js";
import type { InteractivePrompter } from "./interactive-prompter.js";
import {
  inspectManagedInstallations,
  type ManagedInstallationView,
} from "./managed-installations.js";
import {
  type MutationCoordinatorDependencies,
  mutateDescriptorAcrossTargets,
} from "./mutation-coordinator.js";
import type { ValidatedRegistry } from "./registry.js";
import type {
  InstallerCommand,
  InstallerExitCode,
} from "./run-installer-cli.js";
import { resolveRuntimeRequirements } from "./runtime-requirements.js";

type ManagementAction = Extract<
  InstallerCommand["kind"],
  "disable" | "enable" | "remove" | "status"
>;

export interface RunManagementSessionOptions {
  readonly action: ManagementAction;
  readonly dependencies: MutationCoordinatorDependencies;
  readonly prompter: InteractivePrompter;
  readonly registry: ValidatedRegistry;
  readonly resolveExecutable: ExecutableResolver;
  readonly snapshot: HarnessDetectionSnapshot;
}

function cancel(prompter: InteractivePrompter): 130 {
  prompter.cancel(installerErrorMessages.CANCELLED);
  return 130;
}

function statusLine(view: ManagedInstallationView, runtime?: string): string {
  return `${view.installation.serverName} · ${view.displayName}: ${view.status}${runtime === undefined ? "" : ` (${runtime})`}`;
}

async function showStatus(
  options: RunManagementSessionOptions,
  views: readonly ManagedInstallationView[],
): Promise<0> {
  if (views.length === 0) {
    options.prompter.note("No managed MCP installations.", "Status");
    options.prompter.outro("Nothing is installed by Invokta.");
    return 0;
  }
  const lines: string[] = [];
  for (const view of views) {
    let runtime: string | undefined;
    if (
      view.descriptor !== undefined &&
      (view.status === "enabled" || view.status === "outdated")
    ) {
      const requirements = await resolveRuntimeRequirements({
        action: "install",
        descriptor: view.descriptor.server,
        resolveExecutable: options.resolveExecutable,
        environment: options.dependencies.environment,
      });
      if (requirements.kind === "blocked") runtime = requirements.code;
    }
    lines.push(statusLine(view, runtime));
  }
  options.prompter.note(lines.join("\n"), "Managed MCP installations");
  options.prompter.outro("Status inspection complete. No changes were made.");
  return 0;
}

export async function runManagementSession(
  options: RunManagementSessionOptions,
): Promise<InstallerExitCode> {
  const views = await inspectManagedInstallations({
    dependencies: options.dependencies,
    registry: options.registry,
    snapshot: options.snapshot,
  });
  if (options.action === "status") return showStatus(options, views);
  const candidates = views.filter(
    (view) =>
      view.descriptor !== undefined &&
      (options.action === "remove"
        ? view.status === "enabled" ||
          view.status === "disabled" ||
          view.status === "outdated"
        : view.actions.some((action) => action === options.action)),
  );
  if (candidates.length === 0) {
    throw new InstallerError("INSTALLATION_UNAVAILABLE");
  }
  const choices = new Map(
    candidates.map((view, index) => [String(index), view] as const),
  );
  const selection = await options.prompter.select({
    message: `Select an installation to ${options.action}.`,
    options: candidates.map((view, index) => ({
      value: String(index),
      label: `${view.installation.serverName} · ${view.displayName}`,
      hint: view.status,
    })),
  });
  if (selection.kind === "cancelled") return cancel(options.prompter);
  const selected = choices.get(selection.value);
  if (selected?.descriptor === undefined) {
    throw new InstallerError("INSTALLATION_UNAVAILABLE");
  }
  if (options.action === "enable") {
    const requirements = await resolveRuntimeRequirements({
      action: "enable",
      descriptor: selected.descriptor.server,
      resolveExecutable: options.resolveExecutable,
      environment: options.dependencies.environment,
    });
    if (requirements.kind === "blocked") {
      throw new InstallerError(requirements.code);
    }
  }
  const confirmation = await options.prompter.confirm(
    `${options.action === "enable" ? "Enable" : options.action === "disable" ? "Disable" : "Remove"} ${selected.installation.serverName} in ${selected.displayName}?`,
  );
  if (confirmation.kind === "cancelled") return cancel(options.prompter);
  if (!confirmation.value) {
    options.prompter.outro("No changes were made.");
    return 0;
  }
  const [result] = await mutateDescriptorAcrossTargets({
    action: options.action,
    dependencies: options.dependencies,
    descriptor: selected.descriptor,
    snapshot: options.snapshot,
    targetIds: [selected.installation.targetId],
  });
  if (result === undefined || result.outcome === "failed") {
    throw new InstallerError(
      result?.outcome === "failed" ? result.code : "INSTALLATION_UNAVAILABLE",
    );
  }
  options.prompter.outro(
    `${selected.installation.serverName} ${result.outcome}. Reload ${selected.displayName}.`,
  );
  return 0;
}
