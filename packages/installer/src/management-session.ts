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

function installationLabel(view: ManagedInstallationView): string {
  return `${view.installation.serverName} · ${view.displayName}`;
}

function statusLine(view: ManagedInstallationView, runtime?: string): string {
  const status = runtime === undefined ? view.status : "missing-runtime";
  return `${installationLabel(view)}: ${status}${runtime === undefined ? "" : ` (${runtime})`}`;
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

async function removeSelectedInstallations(
  options: RunManagementSessionOptions,
  candidates: readonly ManagedInstallationView[],
): Promise<InstallerExitCode> {
  const selection = await options.prompter.multiselect({
    message: "Select installations to remove (Space: select, A: select all).",
    options: candidates.map((view) => ({
      value: view.key,
      label: installationLabel(view),
      hint: view.status,
    })),
    initialValues: [],
  });
  if (selection.kind === "cancelled") return cancel(options.prompter);
  const selectedKeys = new Set(selection.value);
  if (selectedKeys.size === 0) {
    options.prompter.outro("No changes were made.");
    return 0;
  }
  const candidateKeys = new Set(candidates.map((view) => view.key));
  if ([...selectedKeys].some((key) => !candidateKeys.has(key))) {
    throw new InstallerError("INSTALLATION_UNAVAILABLE");
  }
  const selected = candidates
    .filter((view) => selectedKeys.has(view.key))
    .map((view) => {
      if (view.descriptor === undefined) {
        throw new InstallerError("INSTALLATION_UNAVAILABLE");
      }
      return { view, descriptor: view.descriptor };
    });
  options.prompter.note(
    selected.map(({ view }) => installationLabel(view)).join("\n"),
    "Selected installations",
  );
  const confirmation = await options.prompter.confirm(
    `Remove ${String(selected.length)} selected MCP installation${selected.length === 1 ? "" : "s"}?`,
  );
  if (confirmation.kind === "cancelled") return cancel(options.prompter);
  if (!confirmation.value) {
    options.prompter.outro("No changes were made.");
    return 0;
  }

  let failed = false;
  for (const { view, descriptor } of selected) {
    const [result] = await mutateDescriptorAcrossTargets({
      action: "remove",
      dependencies: options.dependencies,
      descriptor,
      snapshot: options.snapshot,
      targetIds: [view.installation.targetId],
    });
    if (result === undefined || result.outcome === "failed") {
      failed = true;
      const code = result?.code ?? "INSTALLATION_UNAVAILABLE";
      options.prompter.log(
        "error",
        `${installationLabel(view)}: ${code}: ${installerErrorMessages[code]}`,
      );
    } else {
      options.prompter.log(
        "success",
        `${installationLabel(view)}: ${result.outcome === "unchanged" ? "already absent" : "removed"}.`,
      );
    }
  }
  options.prompter.outro(
    failed
      ? "Removal completed with errors."
      : "Selected installations removed. Restart or reload the affected MCP clients.",
  );
  return failed ? 1 : 0;
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
  if (options.action === "remove") {
    return removeSelectedInstallations(options, candidates);
  }
  const choices = new Map(
    candidates.map((view, index) => [String(index), view] as const),
  );
  const selection = await options.prompter.select({
    message: `Select an installation to ${options.action}.`,
    options: candidates.map((view, index) => ({
      value: String(index),
      label: installationLabel(view),
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
    `${options.action === "enable" ? "Enable" : "Disable"} ${selected.installation.serverName} in ${selected.displayName}?`,
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
