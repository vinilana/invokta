export const creatorErrorMessages = Object.freeze({
  TARGET_INVALID: "The project path or name is invalid.",
  TARGET_UNSAFE: "The project target is unsafe to use.",
  TARGET_NOT_EMPTY: "The project target is not empty.",
  SCAFFOLD_CONFLICT: "A scaffold file appeared during creation.",
  WRITE_FAILED: "The project scaffold could not be written.",
  INSTALL_FAILED: "The project dependencies could not be installed.",
} as const);

export type CreatorErrorCode = keyof typeof creatorErrorMessages;
export type CreatorExitCode = 0 | 1 | 2;

const creatorErrorExitCodes = Object.freeze({
  TARGET_INVALID: 2,
  TARGET_UNSAFE: 1,
  TARGET_NOT_EMPTY: 1,
  SCAFFOLD_CONFLICT: 1,
  WRITE_FAILED: 1,
  INSTALL_FAILED: 1,
} as const) satisfies Readonly<Record<CreatorErrorCode, CreatorExitCode>>;

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
    this.details = Object.freeze([...details]);
  }
}

export function renderCreatorDiagnostic(error: CreatorError): string {
  const lines = [
    `${error.code}: ${creatorErrorMessages[error.code]}`,
    ...error.details.map((detail) => `  ${detail}`),
  ];
  return `${lines.join("\n")}\n`;
}
