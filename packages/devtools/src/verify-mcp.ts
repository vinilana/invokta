import {
  connectMcpClient,
  type McpClientConnection,
  type McpClientErrorCode,
  type McpClientOperationOptions,
  type McpClientTarget,
} from "@invokta/mcp";

const initializationDeadlineMs = 15_000;
const catalogDeadlineMs = 15_000;
const maximumCatalogPages = 100;
const maximumCatalogTools = 2_000;
const maximumCatalogBytes = 10_485_760;

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

type VerificationErrorCode = McpClientErrorCode;

export interface McpVerificationIo {
  readonly writeStdout: (text: string) => void | Promise<void>;
  readonly writeStderr: (text: string) => void | Promise<void>;
}

export type McpClientConnector = (
  target: McpClientTarget,
  options?: McpClientOperationOptions,
) => Promise<McpClientConnection>;

export interface RunMcpVerificationOptions {
  readonly target: McpClientTarget;
  readonly io?: Partial<McpVerificationIo>;
  /** Test and embedding seam. Defaults to the public `@invokta/mcp` facade. */
  readonly connect?: McpClientConnector;
  readonly signal?: AbortSignal;
}

interface VerificationSuccess {
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

interface VerificationFailure {
  readonly status: "error";
  readonly code: VerificationErrorCode;
}

class LocalVerificationError extends Error {
  readonly code: VerificationErrorCode;

  constructor(code: VerificationErrorCode) {
    super(verificationErrorMessages[code]);
    this.code = code;
  }
}

function resolveIo(overrides: Partial<McpVerificationIo> | undefined) {
  return {
    writeStdout:
      overrides?.writeStdout ??
      ((text: string) => {
        process.stdout.write(text);
      }),
    writeStderr:
      overrides?.writeStderr ??
      ((text: string) => {
        process.stderr.write(text);
      }),
  } satisfies McpVerificationIo;
}

function isVerificationErrorCode(
  value: unknown,
): value is VerificationErrorCode {
  return (
    typeof value === "string" && Object.hasOwn(verificationErrorMessages, value)
  );
}

function readSafeErrorCode(error: unknown): VerificationErrorCode {
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

function asFailure(error: unknown): VerificationFailure {
  return { status: "error", code: readSafeErrorCode(error) };
}

async function withDeadline<T>(
  deadlineMs: number,
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
    rejectBoundary(new LocalVerificationError("TIMEOUT"));
    controller.abort();
  }, deadlineMs);
  const cancel = (): void => {
    rejectBoundary(new LocalVerificationError("CANCELLED"));
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
    throw new LocalVerificationError("PROTOCOL_ERROR");
  }
  if (serialized === undefined) {
    throw new LocalVerificationError("PROTOCOL_ERROR");
  }
  return Buffer.byteLength(serialized, "utf8");
}

function readToolName(tool: unknown): string {
  if (typeof tool !== "object" || tool === null || Array.isArray(tool)) {
    throw new LocalVerificationError("PROTOCOL_ERROR");
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(tool, "name");
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "string" ||
      descriptor.value.length === 0
    ) {
      throw new LocalVerificationError("PROTOCOL_ERROR");
    }
    return descriptor.value;
  } catch (error) {
    if (error instanceof LocalVerificationError) throw error;
    throw new LocalVerificationError("PROTOCOL_ERROR");
  }
}

async function collectCatalog(
  connection: McpClientConnection,
  signal: AbortSignal,
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
    if (pageCount > maximumCatalogPages) {
      throw new LocalVerificationError("LIMIT_EXCEEDED");
    }
    if (!Array.isArray(page.tools)) {
      throw new LocalVerificationError("PROTOCOL_ERROR");
    }

    for (const tool of page.tools) {
      toolCount += 1;
      if (toolCount > maximumCatalogTools) {
        throw new LocalVerificationError("LIMIT_EXCEEDED");
      }
      const toolName = readToolName(tool);
      if (toolNames.has(toolName)) {
        throw new LocalVerificationError("PROTOCOL_ERROR");
      }
      toolNames.add(toolName);
      catalogBytes += serializedToolBytes(tool) + (toolCount === 1 ? 0 : 1);
      if (catalogBytes > maximumCatalogBytes) {
        throw new LocalVerificationError("LIMIT_EXCEEDED");
      }
    }

    const nextCursor = page.nextCursor;
    if (nextCursor === undefined) {
      hasNextPage = false;
      continue;
    }
    if (typeof nextCursor !== "string") {
      throw new LocalVerificationError("PROTOCOL_ERROR");
    }
    if (pageCount === maximumCatalogPages) {
      throw new LocalVerificationError("LIMIT_EXCEEDED");
    }
    if (cursorHistory.has(nextCursor)) {
      throw new LocalVerificationError("PROTOCOL_ERROR");
    }
    cursorHistory.add(nextCursor);
    cursor = nextCursor;
  }

  return { pageCount, toolCount };
}

async function executeVerification(
  options: RunMcpVerificationOptions,
): Promise<VerificationSuccess | VerificationFailure> {
  let connection: McpClientConnection | undefined;
  let result: VerificationSuccess | VerificationFailure;

  try {
    const connect = options.connect ?? connectMcpClient;
    connection = await withDeadline(
      initializationDeadlineMs,
      options.signal,
      (signal) => connect(options.target, { signal }),
      (lateConnection) => {
        void lateConnection.close().catch(() => undefined);
      },
    );
    const catalog = await withDeadline(
      catalogDeadlineMs,
      options.signal,
      (signal) => collectCatalog(connection as McpClientConnection, signal),
    );
    result = {
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
    result = asFailure(error);
  }

  if (connection !== undefined) {
    try {
      await connection.close();
    } catch {
      if (result.status === "ok") {
        result = { status: "error", code: "CONNECTION_FAILED" };
      }
    }
  }
  return result;
}

async function writeFailure(
  io: McpVerificationIo,
  failure: VerificationFailure,
): Promise<void> {
  try {
    await io.writeStderr(
      `invokta-devtools verify: ${failure.code}: ${verificationErrorMessages[failure.code]}\n`,
    );
  } catch {
    // A gone diagnostic destination cannot change the selected exit code.
  }
}

/**
 * Initializes one explicit MCP target and validates its complete tool catalog.
 * The runner never calls a tool and closes an obtained connection before it
 * writes a successful result.
 */
export async function runMcpVerification(
  options: RunMcpVerificationOptions,
): Promise<0 | 1 | 2> {
  const io = resolveIo(options.io);
  const result = await executeVerification(options);
  if (result.status !== "ok") {
    await writeFailure(io, result);
    return result.code === "INVALID_TARGET" ? 2 : 1;
  }

  try {
    await io.writeStdout(`${JSON.stringify(result)}\n`);
    return 0;
  } catch {
    const failure = {
      status: "error",
      code: "CONNECTION_FAILED",
    } as const;
    await writeFailure(io, failure);
    return 1;
  }
}
