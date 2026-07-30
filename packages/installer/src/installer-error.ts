export const installerErrorMessages = Object.freeze({
  REGISTRY_INVALID: "The local capability registry is invalid.",
  ENGINE_MANIFEST_INVALID: "The Action Engine manifest is invalid.",
  ENGINE_PATH_UNSAFE: "The Action Engine path is unsafe.",
  ENGINE_ENTRYPOINT_MISSING: "The Action Engine entry point was not found.",
  ENGINE_IDENTITY_MISMATCH:
    "The manifest does not match the managed Action Engine identity.",
  REMOTE_INVALID: "The remote MCP server definition is invalid.",
  INSTALLATION_UNAVAILABLE: "The managed installation is unavailable.",
  INSTALLER_INITIALIZATION_FAILED: "The installer could not be initialized.",
  NO_TTY: "The installer requires an interactive terminal.",
  NO_SUPPORTED_HARNESS: "No supported AI harness was detected.",
  HARNESS_CONFIG_INVALID: "The harness configuration is invalid.",
  HARNESS_CONFIG_AMBIGUOUS:
    "More than one harness configuration could be selected.",
  HARNESS_CONFIG_UNSAFE: "The harness configuration path is unsafe.",
  HARNESS_CONFIG_READ_FAILED: "The harness configuration could not be read.",
  TARGET_UNSUPPORTED:
    "This capability cannot be configured for the selected harness.",
  COMMAND_NOT_FOUND: "The MCP server command was not found.",
  REQUIRED_ENV_MISSING: "A required environment variable is missing.",
  CONFIG_CONFLICT: "A different MCP server already uses this name.",
  CONFIG_DRIFT: "The managed MCP server was changed outside the installer.",
  CONFIG_LOCKED: "The harness configuration is locked.",
  CONFIG_CHANGED: "The harness configuration changed during installation.",
  CONFIG_WRITE_FAILED: "The harness configuration could not be updated.",
  STATE_INVALID: "The installer state is invalid.",
  STATE_READ_FAILED: "The installer state could not be read.",
  STATE_LOCKED: "The installer state is locked.",
  STATE_CHANGED: "The installer state changed during installation.",
  STATE_WRITE_FAILED: "The installer state could not be updated.",
  CONFIG_ROLLBACK_FAILED: "The harness configuration could not be restored.",
  CANCELLED: "Installation was cancelled.",
} as const);

export type InstallerErrorCode = keyof typeof installerErrorMessages;

export class InstallerError extends Error {
  readonly code: InstallerErrorCode;

  constructor(code: InstallerErrorCode, cause?: unknown) {
    super(installerErrorMessages[code], { cause });
    this.name = "InstallerError";
    this.code = code;
    Object.defineProperty(this, "code", {
      configurable: false,
      enumerable: true,
      value: code,
      writable: false,
    });
  }
}

export function renderInstallerDiagnostic(error: InstallerError): string {
  return `${error.code}: ${installerErrorMessages[error.code]}\n`;
}
