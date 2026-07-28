import { describe, expect, it } from "vitest";

import {
  DeployError,
  type DeployErrorCode,
  deployErrorExitCodes,
  deployErrorMessages,
  renderDeployDiagnostic,
} from "../src/errors.js";

const contract: [DeployErrorCode, string, 0 | 1 | 2][] = [
  ["MANIFEST_NOT_FOUND", "The deployment manifest was not found.", 2],
  ["MANIFEST_INVALID", "The deployment manifest is invalid.", 2],
  [
    "PACKAGE_JSON_INVALID",
    "The project package.json is missing required fields.",
    1,
  ],
  ["LOCKFILE_MISSING", "No supported lockfile was found.", 1],
  ["LOCKFILE_AMBIGUOUS", "More than one lockfile was found.", 1],
  ["ENTRY_NOT_BUILT", "The HTTP entry module has not been built.", 1],
  [
    "GENERATED_FILE_CONFLICT",
    "An existing file is not managed by the toolkit.",
    1,
  ],
  ["WRITE_FAILED", "A deployment file could not be written.", 1],
  ["PROBE_UNREACHABLE", "The MCP endpoint could not be reached.", 1],
  ["PROBE_UNHEALTHY", "The MCP endpoint is not healthy.", 1],
];

describe("deploy error contract", () => {
  it("declares exactly the specified codes", () => {
    expect(Object.keys(deployErrorMessages)).toEqual(
      contract.map(([code]) => code),
    );
    expect(Object.keys(deployErrorExitCodes)).toEqual(
      contract.map(([code]) => code),
    );
  });

  it.each(contract)(
    "maps %s to its stable message and exit code",
    (code, message, exitCode) => {
      expect(deployErrorMessages[code]).toBe(message);
      expect(deployErrorExitCodes[code]).toBe(exitCode);

      const error = new DeployError(code);

      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe("DeployError");
      expect(error.code).toBe(code);
      expect(error.exitCode).toBe(exitCode);
      expect(error.message).toBe(message);
      expect(error.details).toEqual([]);
    },
  );

  it("freezes the message and exit-code tables", () => {
    expect(Object.isFrozen(deployErrorMessages)).toBe(true);
    expect(Object.isFrozen(deployErrorExitCodes)).toBe(true);
  });

  it("keeps the code and exit code immutable on an instance", () => {
    const error = new DeployError("WRITE_FAILED");

    expect(() => {
      Object.defineProperty(error, "code", { value: "MANIFEST_INVALID" });
    }).toThrow(TypeError);
    expect(error.code).toBe("WRITE_FAILED");
    expect(error.exitCode).toBe(1);
  });

  it("carries details as an immutable list", () => {
    const error = new DeployError("MANIFEST_INVALID", {
      details: ['"/entry": A string is required.'],
    });

    expect(error.details).toEqual(['"/entry": A string is required.']);
    expect(Object.isFrozen(error.details)).toBe(true);
  });
});

describe("renderDeployDiagnostic", () => {
  it("renders one terminated line for an error without details", () => {
    expect(renderDeployDiagnostic(new DeployError("LOCKFILE_MISSING"))).toBe(
      "LOCKFILE_MISSING: No supported lockfile was found.\n",
    );
  });

  it("indents every detail under the stable code line", () => {
    const error = new DeployError("MANIFEST_INVALID", {
      details: [
        '"/entry": The entry path must end in .js or .mjs.',
        '"/image/port": The port must be between 1 and 65535.',
      ],
    });

    expect(renderDeployDiagnostic(error)).toBe(
      `MANIFEST_INVALID: The deployment manifest is invalid.
  "/entry": The entry path must end in .js or .mjs.
  "/image/port": The port must be between 1 and 65535.
`,
    );
  });

  it("never renders a stack trace or a cause chain", () => {
    const error = new DeployError("WRITE_FAILED", {
      details: ['"Dockerfile"'],
    });

    const rendered = renderDeployDiagnostic(error);

    expect(rendered).not.toContain("at ");
    expect(rendered).not.toContain("Error:");
    expect(rendered.split("\n").filter((line) => line !== "")).toHaveLength(2);
  });
});
