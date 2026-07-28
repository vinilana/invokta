import { createClackInteractivePrompter } from "./clack-interactive-prompter.js";
import { installerErrorMessages } from "./installer-error.js";
import type { InstallerExitCode } from "./run-installer-cli.js";

/**
 * Slice 2 establishes the real terminal composition boundary. Registry-driven
 * inventory and mutation are added by the following delivery slices.
 */
export async function runInteractiveSession(): Promise<InstallerExitCode> {
  const prompter = createClackInteractivePrompter();
  prompter.intro("AI Engine capability installer");
  prompter.cancel(installerErrorMessages.INSTALLER_INITIALIZATION_FAILED);
  return 2;
}
