import {
  connectMcpClient,
  type McpClientConnection,
  type McpClientErrorCode,
  type McpClientOperationOptions,
  type McpClientTarget,
} from "@invokta/mcp";

const defaultInitializationDeadlineMs = 15_000;
const defaultCatalogDeadlineMs = 15_000;
const defaultMaxCatalogPages = 100;
const defaultMaxTools = 2_000;
const defaultMaxCatalogBytes = 10_485_760;

const verificationErrorMessages = {
  INVALID_TARGET: "The MCP target is invalid.",
  SPAWN_FAILED: "The MCP server process could not start.",
  CONNECTION_FAILED: "The MCP connection failed.",
  AUTHENTICATION_FAILED: "The MCP target rejected authentication.",
  PROTOCOL_ERROR: "The MCP target returned an invalid protocol response.",
  TIMEOUT: "The MCP verification deadline expired.",
  LIMIT_EXCEEDED: "The MCP verification limit was exceeded.",
  CANCELLED: "The MCP verification was cancelled.",
} as const satisfies Readonly<Record<McpClientErrorCode, string>>;

/** The verification stage a failure is attributed to, if any. */
export type VerifyFailureStage = "initialize" | "catalog" | null;

/**
 * Machine-readable failure context. It never carries secrets, environment
 * values, or protocol payloads — only user-supplied identifiers and the
 * configured limits.
 */
export type VerifyFailureDetails = Readonly<Record<string, string | number>>;

export interface VerifyFailure {
  readonly ok: false;
  readonly code: McpClientErrorCode;
  readonly stage: VerifyFailureStage;
  readonly message: string;
  readonly details?: VerifyFailureDetails;
}

export interface VerifySuccess {
  readonly ok: true;
  readonly status: "ok";
  readonly transport: "stdio" | "http";
  readonly server: {
    readonly name: string;
    readonly version: string;
    readonly protocolVersion: string;
  };
  readonly pageCount: number;
  readonly toolCount: number;
}

export type VerifyRunResult = VerifySuccess | VerifyFailure;

export type McpClientConnector = (
  target: McpClientTarget,
  options?: McpClientOperationOptions,
) => Promise<McpClientConnection>;

export interface RunMcpVerificationOptions {
  readonly target: McpClientTarget;
  /** Test and embedding seam. Defaults to the public `@invokta/mcp` facade. */
  readonly connect?: McpClientConnector;
  readonly signal?: AbortSignal;
  readonly initializationDeadlineMs?: number;
  readonly catalogDeadlineMs?: number;
  readonly maxCatalogPages?: number;
  readonly maxTools?: number;
  readonly maxCatalogBytes?: number;
}

interface VerificationLimits {
  readonly initializationDeadlineMs: number;
  readonly catalogDeadlineMs: number;
  readonly maxCatalogPages: number;
  readonly maxTools: number;
  readonly maxCatalogBytes: number;
}

class LocalVerificationError extends Error {
  readonly code: McpClientErrorCode;
  readonly stage: VerifyFailureStage;
  readonly details: VerifyFailureDetails | undefined;

  constructor(
    code: McpClientErrorCode,
    context?: {
      readonly stage?: VerifyFailureStage;
      readonly message?: string;
      readonly details?: VerifyFailureDetails;
    },
  ) {
    super(context?.message ?? verificationErrorMessages[code]);
    this.code = code;
    this.stage = context?.stage ?? null;
    this.details = context?.details;
  }
}

function resolveLimits(options: RunMcpVerificationOptions): VerificationLimits {
  return {
    initializationDeadlineMs:
      options.initializationDeadlineMs ?? defaultInitializationDeadlineMs,
    catalogDeadlineMs: options.catalogDeadlineMs ?? defaultCatalogDeadlineMs,
    maxCatalogPages: options.maxCatalogPages ?? defaultMaxCatalogPages,
    maxTools: options.maxTools ?? defaultMaxTools,
    maxCatalogBytes: options.maxCatalogBytes ?? defaultMaxCatalogBytes,
  };
}

function isVerificationErrorCode(value: unknown): value is McpClientErrorCode {
  return (
    typeof value === "string" && Object.hasOwn(verificationErrorMessages, value)
  );
}

function readSafeErrorCode(error: unknown): McpClientErrorCode {
  if (
    (typeof error !== "object" || error === null) &&
    typeof error !== "function"
  ) {
    return "CONNECTION_FAILED";
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    if (
      descriptor !== undefined &&
      "value" in descriptor &&
      isVerificationErrorCode(descriptor.value)
    ) {
      return descriptor.value;
    }
  } catch {
    // A proxy or otherwise hostile thrown value is never inspected further.
  }
  return "CONNECTION_FAILED";
}

function asFailure(
  error: unknown,
  stage: VerifyFailureStage,
  target: McpClientTarget,
): VerifyFailure {
  if (error instanceof LocalVerificationError) {
    return {
      ok: false,
      code: error.code,
      stage: error.stage,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  const code = readSafeErrorCode(error);
  if (code === "SPAWN_FAILED" && target.transport === "stdio") {
    return {
      ok: false,
      code,
      stage,
      message: `The MCP server process could not start: the executable "${target.command}" failed to spawn.`,
      details: { executable: target.command },
    };
  }
  return {
    ok: false,
    code,
    stage,
    message: verificationErrorMessages[code],
  };
}

function limitExceeded(limit: string, value: number) {
  return {
    stage: "catalog" as const,
    message: `The MCP verification limit was exceeded: ${limit} (${String(value)}).`,
    details: { limit, value },
  };
}

async function withDeadline<T>(
  deadlineMs: number,
  stage: "initialize" | "catalog",
  callerSignal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
  onLateValue?: (value: T) => void,
): Promise<T> {
  if (callerSignal?.aborted === true) {
    throw new LocalVerificationError("CANCELLED");
  }

  const controller = new AbortController();
  let rejectBoundary!: (error: LocalVerificationError) => void;
  const boundary = new Promise<never>((_resolve, reject) => {
    rejectBoundary = reject;
  });
  const timeout = setTimeout(() => {
    rejectBoundary(
      new LocalVerificationError("TIMEOUT", {
        stage,
        message: `The MCP ${stage === "initialize" ? "initialization" : "catalog"} deadline of ${String(deadlineMs)} ms expired.`,
        details: { stage, deadlineMs },
      }),
    );
    controller.abort();
  }, deadlineMs);
  const cancel = (): void => {
    rejectBoundary(new LocalVerificationError("CANCELLED", { stage }));
    controller.abort();
  };
  callerSignal?.addEventListener("abort", cancel, { once: true });

  let boundarySettled = false;
  try {
    const pending = Promise.resolve().then(() => operation(controller.signal));
    void pending.then(
      (value) => {
        if (!boundarySettled) return;
        try {
          onLateValue?.(value);
        } catch {
          // The bounded result already settled; late cleanup is best-effort.
        }
      },
      () => undefined,
    );
    return await Promise.race([pending, boundary]);
  } finally {
    boundarySettled = true;
    clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", cancel);
  }
}

function serializedToolBytes(tool: unknown): number {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(tool);
  } catch {
    throw new LocalVerificationError("PROTOCOL_ERROR", { stage: "catalog" });
  }
  if (serialized === undefined) {
    throw new LocalVerificationError("PROTOCOL_ERROR", { stage: "catalog" });
  }
  return Buffer.byteLength(serialized, "utf8");
}

function readToolName(tool: unknown): string {
  if (typeof tool !== "object" || tool === null || Array.isArray(tool)) {
    throw new LocalVerificationError("PROTOCOL_ERROR", { stage: "catalog" });
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(tool, "name");
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "string" ||
      descriptor.value.length === 0
    ) {
      throw new LocalVerificationError("PROTOCOL_ERROR", { stage: "catalog" });
    }
    return descriptor.value;
  } catch (error) {
    if (error instanceof LocalVerificationError) throw error;
    throw new LocalVerificationError("PROTOCOL_ERROR", { stage: "catalog" });
  }
}

async function collectCatalog(
  connection: McpClientConnection,
  signal: AbortSignal,
  limits: VerificationLimits,
): Promise<{ readonly pageCount: number; readonly toolCount: number }> {
  let cursor: string | undefined;
  let hasNextPage = true;
  let pageCount = 0;
  let toolCount = 0;
  // Two bytes account for the opening and closing brackets of compact JSON.
  let catalogBytes = 2;
  const cursorHistory = new Set<string>();
  const toolNames = new Set<string>();

  while (hasNextPage) {
    const page = await connection.listTools(cursor, { signal });
    pageCount += 1;
    if (pageCount > limits.maxCatalogPages) {
      throw new LocalVerificationError(
        "LIMIT_EXCEEDED",
        limitExceeded("maxCatalogPages", limits.maxCatalogPages),
      );
    }
    if (!Array.isArray(page.tools)) {
      throw new LocalVerificationError("PROTOCOL_ERROR", { stage: "catalog" });
    }

    for (const tool of page.tools) {
      toolCount += 1;
      if (toolCount > limits.maxTools) {
        throw new LocalVerificationError(
          "LIMIT_EXCEEDED",
          limitExceeded("maxTools", limits.maxTools),
        );
      }
      const toolName = readToolName(tool);
      if (toolNames.has(toolName)) {
        throw new LocalVerificationError("PROTOCOL_ERROR", {
          stage: "catalog",
        });
      }
      toolNames.add(toolName);
      catalogBytes += serializedToolBytes(tool) + (toolCount === 1 ? 0 : 1);
      if (catalogBytes > limits.maxCatalogBytes) {
        throw new LocalVerificationError(
          "LIMIT_EXCEEDED",
          limitExceeded("maxCatalogBytes", limits.maxCatalogBytes),
        );
      }
    }

    const nextCursor = page.nextCursor;
    if (nextCursor === undefined) {
      hasNextPage = false;
      continue;
    }
    if (typeof nextCursor !== "string") {
      throw new LocalVerificationError("PROTOCOL_ERROR", { stage: "catalog" });
    }
    if (pageCount === limits.maxCatalogPages) {
      throw new LocalVerificationError(
        "LIMIT_EXCEEDED",
        limitExceeded("maxCatalogPages", limits.maxCatalogPages),
      );
    }
    if (cursorHistory.has(nextCursor)) {
      throw new LocalVerificationError("PROTOCOL_ERROR", { stage: "catalog" });
    }
    cursorHistory.add(nextCursor);
    cursor = nextCursor;
  }

  return { pageCount, toolCount };
}

/**
 * Initializes one explicit MCP target and validates its complete tool catalog.
 * The runner never calls a tool, closes an obtained connection before it
 * returns a successful result, and never writes to stdout or stderr — the
 * caller renders the returned result.
 */
export async function runMcpVerification(
  options: RunMcpVerificationOptions,
): Promise<VerifyRunResult> {
  const limits = resolveLimits(options);
  let connection: McpClientConnection | undefined;
  let result: VerifyRunResult;
  let stage: VerifyFailureStage = null;

  try {
    const connect = options.connect ?? connectMcpClient;
    stage = "initialize";
    connection = await withDeadline(
      limits.initializationDeadlineMs,
      "initialize",
      options.signal,
      (signal) => connect(options.target, { signal }),
      (lateConnection) => {
        void lateConnection.close().catch(() => undefined);
      },
    );
    stage = "catalog";
    const catalog = await withDeadline(
      limits.catalogDeadlineMs,
      "catalog",
      options.signal,
      (signal) =>
        collectCatalog(connection as McpClientConnection, signal, limits),
    );
    stage = null;
    result = {
      ok: true,
      status: "ok",
      transport: options.target.transport,
      server: {
        name: connection.server.name,
        version: connection.server.version,
        protocolVersion: connection.server.protocolVersion,
      },
      pageCount: catalog.pageCount,
      toolCount: catalog.toolCount,
    };
  } catch (error) {
    result = asFailure(error, stage, options.target);
  }

  if (connection !== undefined) {
    try {
      await connection.close();
    } catch {
      if (result.ok) {
        result = {
          ok: false,
          code: "CONNECTION_FAILED",
          stage: null,
          message: verificationErrorMessages.CONNECTION_FAILED,
        };
      }
    }
  }
  return result;
}

export interface RenderedMcpVerification {
  readonly exitCode: 0 | 1 | 2;
  readonly stdout?: string;
  readonly stderr?: string;
}

/**
 * Renders a verification result for a terminal: the legacy success JSON line
 * on stdout (without the `ok` discriminant, so existing stdout consumers keep
 * working) or a single diagnostic line on stderr, plus the exit code the CLI
 * should use.
 */
export function renderMcpVerificationResult(
  result: VerifyRunResult,
): RenderedMcpVerification {
  if (result.ok) {
    const legacySuccess = {
      status: result.status,
      transport: result.transport,
      server: result.server,
      pageCount: result.pageCount,
      toolCount: result.toolCount,
    };
    return { exitCode: 0, stdout: `${JSON.stringify(legacySuccess)}\n` };
  }
  return {
    exitCode: result.code === "INVALID_TARGET" ? 2 : 1,
    stderr: `invokta-devtools verify: ${result.code}: ${result.message}\n`,
  };
}
