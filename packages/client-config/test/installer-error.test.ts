import { describe, expect, it } from "vitest";

import {
  InstallerError,
  installerErrorMessages,
  renderInstallerDiagnostic,
} from "../src/installer-error.js";

const expectedErrors = {
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
} as const;

describe("InstallerError", () => {
  it("defines exactly the 29 stable installer codes and messages", () => {
    expect(installerErrorMessages).toEqual(expectedErrors);
    expect(Object.keys(installerErrorMessages)).toHaveLength(29);

    for (const [code, message] of Object.entries(expectedErrors)) {
      const error = new InstallerError(
        code as keyof typeof expectedErrors,
        new Error("private cause"),
      );

      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe("InstallerError");
      expect(error.code).toBe(code);
      expect(error.message).toBe(message);
      expect(renderInstallerDiagnostic(error)).toBe(`${code}: ${message}\n`);
    }
  });

  it("renders from the stable table without touching a hostile cause", () => {
    const secret = "secret-token-value";
    const hostileCause = new Proxy(Object.create(null) as object, {
      get() {
        throw new Error(secret);
      },
      ownKeys() {
        throw new Error(secret);
      },
    });
    const error = new InstallerError("STATE_READ_FAILED", hostileCause);

    Object.defineProperty(error, "message", {
      configurable: true,
      get() {
        throw new Error(secret);
      },
    });

    const diagnostic = renderInstallerDiagnostic(error);

    expect(diagnostic).toBe(
      "STATE_READ_FAILED: The installer state could not be read.\n",
    );
    expect(diagnostic).not.toContain(secret);
  });
});
