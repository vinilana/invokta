import type {
  ConfigurationTargetId,
  ConfigurationTargetSnapshot,
  HarnessDetectionSnapshot,
} from "@invokta/client-config";
import { InstallerError, installerErrorMessages } from "@invokta/client-config";
import type { InteractivePrompter } from "./interactive-prompter.js";
import type { InstallerExitCode } from "./run-installer-cli.js";

type InventorySelection = ConfigurationTargetId | "dismiss";

function inventoryResult(target: ConfigurationTargetSnapshot): string {
  const configuration =
    target.configuration.kind === "blocked"
      ? target.configuration.code
      : target.configuration.path;
  const surfaces =
    target.surfaceIds.length === 0 ? "none" : target.surfaceIds.join(", ");
  return [
    `Surfaces: ${surfaces}`,
    `Evidence: ${target.evidence}`,
    `Configuration: ${configuration}`,
    `Configuration creation: ${target.mayCreateConfiguration ? "allowed" : "not allowed"}`,
    `Reload: ${target.reloadHint}`,
  ].join("\n");
}

function cancelInventory(prompter: InteractivePrompter): 130 {
  prompter.cancel(installerErrorMessages.CANCELLED);
  return 130;
}

export async function runReadOnlyInventory(
  snapshot: HarnessDetectionSnapshot,
  prompter: InteractivePrompter,
): Promise<InstallerExitCode> {
  const targets = snapshot.targets.filter(
    ({ evidence }) => evidence !== "absent",
  );
  if (targets.length === 0) {
    prompter.note(
      installerErrorMessages.NO_SUPPORTED_HARNESS,
      "Harness inventory",
    );
    const dismissal = await prompter.select({
      message: "No supported harnesses were found.",
      options: [{ value: "dismiss", label: "Dismiss" }],
    });
    if (dismissal.kind === "cancelled") return cancelInventory(prompter);
    prompter.outro("No changes were made.");
    return 0;
  }

  prompter.note(
    `${String(targets.length)} supported configuration target${targets.length === 1 ? "" : "s"} detected.`,
    "Harness inventory",
  );
  const selection = await prompter.select<InventorySelection>({
    message: "Inspect a detected target.",
    options: [
      ...targets.map((target) => ({
        value: target.id,
        label: target.displayName,
        hint:
          target.configuration.kind === "blocked"
            ? target.configuration.code
            : target.evidence,
        ...(target.configuration.kind === "blocked" ? { disabled: true } : {}),
      })),
      { value: "dismiss" as const, label: "Done" },
    ],
  });
  if (selection.kind === "cancelled") return cancelInventory(prompter);
  if (selection.value !== "dismiss") {
    const target = targets.find(({ id }) => id === selection.value);
    if (target === undefined) {
      throw new InstallerError("INSTALLER_INITIALIZATION_FAILED");
    }
    prompter.note(inventoryResult(target), target.displayName);
  }
  prompter.outro("Read-only inventory complete. No changes were made.");
  return 0;
}
