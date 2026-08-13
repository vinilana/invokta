import type { AdapterId } from "./adapters.js";

export interface AdapterInfo {
  readonly id: AdapterId;
  readonly source: string;
  readonly label: string;
  readonly identity: "per-request" | "process";
}

export interface EngineInfo {
  readonly name: string;
  readonly version: string;
  readonly capabilityCount: number;
  readonly engineHost: { readonly host: string; readonly port: number };
  readonly adapters?: readonly AdapterInfo[];
  readonly maxConcurrentInvocations?: number;
}

export interface CapabilityInfo {
  readonly id: string;
  readonly mcpToolName: string;
  readonly title?: string;
  readonly description: string;
  readonly annotations?: Readonly<Record<string, boolean>>;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly timeoutMs?: number;
}

export interface DoctorInfo {
  readonly engineName: string;
  readonly engineVersion: string;
  readonly capabilityCount?: number;
  readonly findings: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly notes: ReadonlyArray<Readonly<Record<string, unknown>>>;
}

export interface PrincipalInfo {
  readonly key: string;
  readonly principal: {
    readonly id: string;
    readonly attributes?: Readonly<Record<string, unknown>>;
  };
}

export interface IssuedPrincipal extends PrincipalInfo {
  readonly token: string;
}

/** Carries the server-reported error code alongside a readable message. */
export class ApiError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

const requestTimeoutMs = 10_000;

function timeoutSignal(): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" &&
    typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(requestTimeoutMs)
    : undefined;
}

async function getJson<Value>(path: string): Promise<Value> {
  const signal = timeoutSignal();
  const response = await fetch(path, signal === undefined ? {} : { signal });
  if (!response.ok)
    throw new Error(`${path} answered ${String(response.status)}`);
  return (await response.json()) as Value;
}

interface ErrorDetail {
  readonly code: string | undefined;
  readonly message: string | undefined;
}

async function readErrorDetail(response: Response): Promise<ErrorDetail> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { code: undefined, message: undefined };
  }
  if (typeof body !== "object" || body === null) {
    return { code: undefined, message: undefined };
  }
  const detail = body as {
    readonly error?: unknown;
    readonly message?: unknown;
  };
  return {
    code: typeof detail.error === "string" ? detail.error : undefined,
    message: typeof detail.message === "string" ? detail.message : undefined,
  };
}

/** Rejects with the server's code/message when the body carries them. */
async function failWithDetail(
  response: Response,
  fallback: string,
): Promise<never> {
  const detail = await readErrorDetail(response);
  const message =
    detail.message ??
    (detail.code === undefined ? fallback : `${fallback} (${detail.code})`);
  throw new ApiError(message, detail.code);
}

export const api = {
  engine: () => getJson<EngineInfo>("/api/engine"),
  capabilities: () => getJson<readonly CapabilityInfo[]>("/api/capabilities"),
  doctor: () => getJson<DoctorInfo>("/api/doctor"),
  principals: () => getJson<readonly PrincipalInfo[]>("/api/principals"),
  createPrincipal: async (principal: {
    readonly id: string;
    readonly attributes?: Readonly<Record<string, unknown>>;
  }): Promise<IssuedPrincipal> => {
    const response = await fetch("/api/principals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principal }),
    });
    if (!response.ok)
      await failWithDetail(response, "The test identity could not be added.");
    return (await response.json()) as IssuedPrincipal;
  },
  rotatePrincipal: async (key: string): Promise<IssuedPrincipal> => {
    const response = await fetch("/api/principals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key }),
    });
    if (!response.ok)
      await failWithDetail(response, "The token could not be minted.");
    return (await response.json()) as IssuedPrincipal;
  },
  removePrincipal: async (key: string): Promise<void> => {
    const response = await fetch("/api/principals", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key }),
    });
    if (!response.ok)
      await failWithDetail(response, "The test identity could not be deleted.");
  },
};

export interface McpExchange {
  readonly status: number;
  readonly contentType: string | null;
  readonly requestBody: string;
  readonly responseBody: string;
}

export interface ToolCallRequest {
  readonly path: string;
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * Builds the exact request `callTool` sends so other surfaces (for example a
 * "Copy as curl" action) replay the same exchange byte for byte.
 */
export function toolCallRequest(
  toolName: string,
  args: unknown,
  token: string | null,
): ToolCallRequest {
  return {
    path: "/mcp",
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: toolName, arguments: args },
      },
      null,
      2,
    ),
  };
}

export type AdapterOutcome = "success" | "capability-error" | "adapter-error";

export interface AdapterErrorInfo {
  readonly code: string;
  readonly message: string;
  readonly publicDetails?: unknown;
}

/** What the selected adapter actually exchanged with the engine. */
export type AdapterExchange =
  | {
      readonly kind: "http";
      readonly method: "POST";
      readonly url: string;
      readonly status: number;
      readonly requestBody: string;
      readonly responseBody: string;
    }
  | {
      readonly kind: "stdio";
      readonly command: string;
      readonly request: string;
      readonly response: string;
    }
  | {
      readonly kind: "process";
      readonly command: string;
      readonly argv: readonly string[];
      readonly exitCode: number | null;
      readonly signal: string | null;
      readonly stdout: string;
      readonly stderr: string;
    };

export interface AdapterInvocationResult {
  readonly adapter: AdapterId;
  readonly capabilityId: string;
  readonly outcome: AdapterOutcome;
  readonly durationMs: number;
  readonly result?: unknown;
  readonly error?: AdapterErrorInfo;
  readonly exchange: AdapterExchange;
}

export interface AdapterInvocationRequest {
  readonly adapter: AdapterId;
  readonly capabilityId: string;
  readonly arguments: unknown;
  readonly principalKey: string | null;
}

/**
 * Runs one capability call through the selected adapter. The dev server owns
 * the adapter, so the browser sends the same request whichever path carries
 * it and reads back one normalized outcome.
 */
export async function invokeCapability(
  request: AdapterInvocationRequest,
  signal?: AbortSignal,
): Promise<AdapterInvocationResult> {
  const response = await fetch("/api/invoke", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      adapter: request.adapter,
      capabilityId: request.capabilityId,
      arguments: request.arguments,
      ...(request.principalKey === null
        ? {}
        : { principalKey: request.principalKey }),
    }),
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) {
    await failWithDetail(response, "The capability could not be invoked.");
  }
  return (await response.json()) as AdapterInvocationResult;
}

/** Sends one raw MCP `tools/call` through the same-origin proxy. */
export async function callTool(
  toolName: string,
  args: unknown,
  token: string | null,
  signal?: AbortSignal,
): Promise<McpExchange> {
  const request = toolCallRequest(toolName, args, token);
  const response = await fetch(request.path, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    ...(signal === undefined ? {} : { signal }),
  });
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    requestBody: request.body,
    responseBody: await response.text(),
  };
}
