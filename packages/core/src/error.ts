export type EngineErrorCode =
  | "CAPABILITY_NOT_FOUND"
  | "INPUT_INVALID"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "OUTPUT_INVALID"
  | "CANCELLED"
  | "EXECUTION_FAILED";

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly publicDetails?: unknown;
  override readonly cause?: unknown;

  constructor(options: {
    code: EngineErrorCode;
    message: string;
    publicDetails?: unknown;
    cause?: unknown;
  }) {
    super(
      options.message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "EngineError";
    this.code = options.code;
    if (options.publicDetails !== undefined) {
      this.publicDetails = options.publicDetails;
    }
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}
