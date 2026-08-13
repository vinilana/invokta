import type { DeployExitCode } from "./io.js";

/**
 * The stable code and message are the public contract of a toolkit failure.
 * These are toolkit errors, not `EngineError` values: they occur before any
 * engine exists and have no request, event, or transport mapping.
 */
export const deployErrorMessages = Object.freeze({
  MANIFEST_NOT_FOUND: "The deployment manifest was not found.",
  MANIFEST_INVALID: "The deployment manifest is invalid.",
  PACKAGE_JSON_INVALID: "The project package.json is missing required fields.",
  LOCKFILE_MISSING: "No supported lockfile was found.",
  LOCKFILE_AMBIGUOUS: "More than one lockfile was found.",
  ENTRY_NOT_BUILT: "The HTTP entry module has not been built.",
  GENERATED_FILE_CONFLICT: "An existing file is not managed by the toolkit.",
  WRITE_FAILED: "A deployment file could not be written.",
  PROBE_UNREACHABLE: "The MCP endpoint could not be reached.",
  PROBE_UNHEALTHY: "The MCP endpoint is not healthy.",
  OAUTH_INSPECTION_FAILED: "OAuth discovery is not ready.",
} as const);

export type DeployErrorCode = keyof typeof deployErrorMessages;

export const deployErrorExitCodes = Object.freeze({
  MANIFEST_NOT_FOUND: 2,
  MANIFEST_INVALID: 2,
  PACKAGE_JSON_INVALID: 1,
  LOCKFILE_MISSING: 1,
  LOCKFILE_AMBIGUOUS: 1,
  ENTRY_NOT_BUILT: 1,
  GENERATED_FILE_CONFLICT: 1,
  WRITE_FAILED: 1,
  PROBE_UNREACHABLE: 1,
  PROBE_UNHEALTHY: 1,
  OAUTH_INSPECTION_FAILED: 1,
} as const) satisfies Readonly<Record<DeployErrorCode, DeployExitCode>>;

export interface DeployErrorOptions {
  /**
   * Sanitized diagnostic lines such as a file path, a JSON pointer, or an HTTP
   * status. A detail MUST NOT carry an environment value, a header value, a
   * response body, or a rejected manifest value.
   */
  readonly details?: readonly string[];
}

export class DeployError extends Error {
  readonly code: DeployErrorCode;
  readonly exitCode: DeployExitCode;
  readonly details: readonly string[];

  constructor(code: DeployErrorCode, options: DeployErrorOptions = {}) {
    super(deployErrorMessages[code]);
    this.name = "DeployError";
    // No cause is accepted or stored: a diagnostic never reports a cause chain
    // or a stack, so nothing may reach one through this error.
    this.code = code;
    this.exitCode = deployErrorExitCodes[code];
    this.details = Object.freeze([...(options.details ?? [])]);
    for (const key of ["code", "exitCode", "details"] as const) {
      Object.defineProperty(this, key, {
        configurable: false,
        enumerable: true,
        value: this[key],
        writable: false,
      });
    }
  }
}

/**
 * Renders the stable code line followed by one indented line per detail. The
 * result is terminated with a line feed and is the only text a command writes
 * for a toolkit failure.
 */
export function renderDeployDiagnostic(error: DeployError): string {
  const lines = [
    `${error.code}: ${deployErrorMessages[error.code]}`,
    ...error.details.map((detail) => `  ${detail}`),
  ];
  return `${lines.join("\n")}\n`;
}
