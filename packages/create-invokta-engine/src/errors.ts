export const creatorErrorMessages = Object.freeze({
  INTERACTIVE_REQUIRED:
    "Interactive input is required when no project directory is provided.",
  PROMPT_INVALID: "Interactive input is invalid.",
  PROMPT_ABORTED: "Interactive project creation was interrupted.",
  TARGET_INVALID: "The project path or name is invalid.",
  TARGET_UNSAFE: "The project target is unsafe to use.",
  TARGET_NOT_EMPTY: "The project target is not empty.",
  SCAFFOLD_CONFLICT: "A scaffold file appeared during creation.",
  WRITE_FAILED: "The project scaffold could not be written.",
  INSTALL_FAILED: "The project dependencies could not be installed.",
  EXAMPLE_INVALID: "The example reference is invalid.",
  EXAMPLE_UNAVAILABLE: "The example could not be resolved or downloaded.",
  EXAMPLE_FAILED: "The example project could not be created.",
  OPENAPI_INVALID: "The OpenAPI document is invalid.",
  OPENAPI_UNAVAILABLE: "The OpenAPI document could not be read.",
  OPENAPI_UNSUPPORTED:
    "The OpenAPI document has no supported operation to import.",
  OPENAPI_SELECTION_INVALID: "The OpenAPI operation selection is invalid.",
  OPENAPI_LIMIT_EXCEEDED: "The OpenAPI import exceeds a supported limit.",
} as const);

export type CreatorErrorCode = keyof typeof creatorErrorMessages;
export type CreatorExitCode = 0 | 1 | 2;

const creatorErrorExitCodes = Object.freeze({
  INTERACTIVE_REQUIRED: 2,
  PROMPT_INVALID: 2,
  PROMPT_ABORTED: 1,
  TARGET_INVALID: 2,
  TARGET_UNSAFE: 1,
  TARGET_NOT_EMPTY: 1,
  SCAFFOLD_CONFLICT: 1,
  WRITE_FAILED: 1,
  INSTALL_FAILED: 1,
  EXAMPLE_INVALID: 2,
  EXAMPLE_UNAVAILABLE: 1,
  EXAMPLE_FAILED: 1,
  OPENAPI_INVALID: 2,
  OPENAPI_UNAVAILABLE: 1,
  OPENAPI_UNSUPPORTED: 1,
  OPENAPI_SELECTION_INVALID: 2,
  OPENAPI_LIMIT_EXCEEDED: 1,
} as const) satisfies Readonly<Record<CreatorErrorCode, CreatorExitCode>>;

const unsafeDiagnosticCharacterPattern = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

function escapeDiagnosticCharacter(character: string): string {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) return "";
  if (codePoint <= 0xffff) {
    return `\\u${codePoint.toString(16).padStart(4, "0")}`;
  }
  return `\\u{${codePoint.toString(16)}}`;
}

/** Escapes terminal-active characters in diagnostic detail strings. */
export function sanitizeDiagnosticDetail(detail: string): string {
  return detail.replace(
    unsafeDiagnosticCharacterPattern,
    escapeDiagnosticCharacter,
  );
}

/** A sanitized creator failure. It intentionally stores no cause or raw input. */
export class CreatorError extends Error {
  readonly code: CreatorErrorCode;
  readonly exitCode: CreatorExitCode;
  readonly details: readonly string[];

  constructor(code: CreatorErrorCode, details: readonly string[] = []) {
    super(creatorErrorMessages[code]);
    this.name = "CreatorError";
    this.code = code;
    this.exitCode = creatorErrorExitCodes[code];
    this.details = Object.freeze(details.map(sanitizeDiagnosticDetail));
  }
}

export function renderCreatorDiagnostic(error: CreatorError): string {
  const lines = [
    `${error.code}: ${creatorErrorMessages[error.code]}`,
    ...error.details.map((detail) => `  ${detail}`),
  ];
  return `${lines.join("\n")}\n`;
}
