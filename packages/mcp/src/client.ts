import { types as nodeTypes } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ErrorCode,
  type JSONRPCMessage,
  McpError,
  type MessageExtraInfo,
} from "@modelcontextprotocol/sdk/types.js";

export type McpJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly McpJsonValue[]
  | { readonly [key: string]: McpJsonValue };

export type McpClientTarget =
  | {
      readonly transport: "stdio";
      readonly command: string;
      readonly args?: readonly string[];
      readonly cwd?: string;
      readonly env?: Readonly<Record<string, string>>;
    }
  | {
      readonly transport: "http";
      readonly url: string;
      readonly authentication?:
        | { readonly type: "none" }
        | { readonly type: "bearer"; readonly token: string }
        | {
            readonly type: "headers";
            readonly headers: Readonly<Record<string, string>>;
          };
    };

export interface McpClientServerInfo {
  readonly name: string;
  readonly version: string;
  readonly protocolVersion: string;
  readonly instructions?: string;
  readonly capabilities: Readonly<Record<string, McpJsonValue>>;
}

export interface McpClientTool {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, McpJsonValue>>;
  readonly outputSchema?: Readonly<Record<string, McpJsonValue>>;
  readonly annotations?: Readonly<Record<string, McpJsonValue>>;
}

export interface McpClientToolPage {
  readonly tools: readonly McpClientTool[];
  readonly nextCursor?: string;
}

export interface McpClientToolResult {
  readonly response: Readonly<Record<string, McpJsonValue>>;
}

export interface McpClientOperationOptions {
  readonly signal?: AbortSignal;
}

export interface McpClientConnection {
  readonly server: McpClientServerInfo;
  listTools(
    cursor?: string,
    options?: McpClientOperationOptions,
  ): Promise<McpClientToolPage>;
  callTool(
    name: string,
    argumentsValue?: Readonly<Record<string, McpJsonValue>>,
    options?: McpClientOperationOptions,
  ): Promise<McpClientToolResult>;
  close(): Promise<void>;
}

export type McpClientErrorCode =
  | "INVALID_TARGET"
  | "SPAWN_FAILED"
  | "CONNECTION_FAILED"
  | "AUTHENTICATION_FAILED"
  | "PROTOCOL_ERROR"
  | "TIMEOUT"
  | "LIMIT_EXCEEDED"
  | "CANCELLED";

export class McpClientError extends Error {
  declare readonly code: McpClientErrorCode;
  declare readonly message: string;

  constructor(
    code: McpClientErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super();
    Object.defineProperties(this, {
      code: {
        configurable: false,
        enumerable: true,
        value: code,
        writable: false,
      },
      message: {
        configurable: false,
        enumerable: true,
        value: message,
        writable: false,
      },
      ...(options?.cause === undefined
        ? {}
        : {
            cause: {
              configurable: false,
              enumerable: false,
              value: options.cause,
              writable: false,
            },
          }),
    });
  }
}

const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;
const CLIENT_NAME = "invokta-mcp-client";
const CLIENT_VERSION = "0.3.0";
const HTTP_HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HTTP_WHITESPACE_AT_START_OR_END = /^(?:[\t ])|(?:[\t ])$/;
const textEncoder = new TextEncoder();

const ERROR_MESSAGES = {
  INVALID_TARGET: "The MCP client target is invalid.",
  SPAWN_FAILED: "The MCP server process could not be started.",
  CONNECTION_FAILED: "The MCP client connection failed.",
  AUTHENTICATION_FAILED: "The MCP target rejected the supplied credentials.",
  PROTOCOL_ERROR: "The MCP peer returned an invalid protocol exchange.",
  TIMEOUT: "The MCP client operation timed out.",
  LIMIT_EXCEEDED: "The MCP client message limit was exceeded.",
  CANCELLED: "The MCP client operation was cancelled.",
} as const satisfies Record<McpClientErrorCode, string>;

class ClientBoundaryFailure extends Error {
  constructor(readonly code: McpClientErrorCode) {
    super();
  }
}

interface StdioTargetSnapshot {
  readonly transport: "stdio";
  readonly command: string;
  readonly args: string[];
  readonly cwd?: string;
  readonly env: Record<string, string>;
}

interface HttpTargetSnapshot {
  readonly transport: "http";
  readonly url: URL;
  readonly credentials: Record<string, string>;
}

type TargetSnapshot = StdioTargetSnapshot | HttpTargetSnapshot;

interface ConnectionState {
  closing: boolean;
  connected: boolean;
  failure?: ClientBoundaryFailure;
}

function clientError(
  code: McpClientErrorCode,
  cause?: unknown,
): McpClientError {
  return new McpClientError(
    code,
    ERROR_MESSAGES[code],
    cause === undefined ? undefined : { cause },
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || nodeTypes.isProxy(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function createDataRecord<Value>(): Record<string, Value> {
  return Object.create(null) as Record<string, Value>;
}

function defineDataProperty<Value>(
  record: Record<string, Value>,
  key: string,
  value: Value,
): void {
  Object.defineProperty(record, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function dataProperties(value: unknown): Record<string, unknown> | undefined {
  if (!isPlainRecord(value)) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const snapshot = createDataRecord<unknown>();
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") return undefined;
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      return undefined;
    }
    defineDataProperty(snapshot, key, descriptor.value);
  }
  return snapshot;
}

function hasExactlyKeys(
  record: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(record);
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(record, key)) &&
    keys.every((key) => allowed.has(key))
  );
}

function snapshotStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || nodeTypes.isProxy(value)) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    typeof lengthDescriptor.value !== "number"
  ) {
    return undefined;
  }
  const length = lengthDescriptor.value;
  const snapshot: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "string"
    ) {
      return undefined;
    }
    snapshot.push(descriptor.value);
  }
  const expectedKeys = new Set([
    "length",
    ...snapshot.map((_, index) => String(index)),
  ]);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) => typeof key !== "string" || !expectedKeys.has(key),
    )
  ) {
    return undefined;
  }
  return snapshot;
}

function snapshotStringRecord(
  value: unknown,
  validateName: (name: string) => boolean,
  validateValue: (value: string) => boolean,
): Record<string, string> | undefined {
  const record = dataProperties(value);
  if (record === undefined) return undefined;
  const snapshot = createDataRecord<string>();
  for (const [key, entry] of Object.entries(record)) {
    if (
      !validateName(key) ||
      typeof entry !== "string" ||
      !validateValue(entry)
    ) {
      return undefined;
    }
    defineDataProperty(snapshot, key, entry);
  }
  return snapshot;
}

function parseCanonicalHttpUrl(value: unknown): URL | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("?") ||
    value.includes("#")
  ) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.hostname === ""
  ) {
    return undefined;
  }
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "[::1]")
    )
  ) {
    return undefined;
  }
  const serialized = url.href;
  if (serialized !== value && serialized !== `${value}/`) return undefined;
  return url;
}

function isForbiddenCustomHeader(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    normalized === "host" ||
    normalized === "origin" ||
    normalized === "accept" ||
    normalized === "content-type" ||
    normalized === "content-length" ||
    normalized === "transfer-encoding" ||
    normalized === "connection" ||
    normalized === "upgrade" ||
    normalized === "cookie" ||
    normalized === "set-cookie" ||
    normalized === "mcp-session-id" ||
    normalized === "mcp-protocol-version" ||
    normalized === "last-event-id" ||
    normalized.startsWith("sec-") ||
    normalized.startsWith("proxy-")
  );
}

function snapshotAuthentication(
  value: unknown,
): Record<string, string> | undefined {
  if (value === undefined) return {};
  const authentication = dataProperties(value);
  if (authentication === undefined || typeof authentication.type !== "string") {
    return undefined;
  }
  if (authentication.type === "none") {
    return hasExactlyKeys(authentication, ["type"]) ? {} : undefined;
  }
  if (authentication.type === "bearer") {
    if (
      !hasExactlyKeys(authentication, ["type", "token"]) ||
      typeof authentication.token !== "string" ||
      authentication.token.length === 0 ||
      HTTP_WHITESPACE_AT_START_OR_END.test(authentication.token) ||
      authentication.token.includes("\r") ||
      authentication.token.includes("\n")
    ) {
      return undefined;
    }
    return { authorization: `Bearer ${authentication.token}` };
  }
  if (
    authentication.type !== "headers" ||
    !hasExactlyKeys(authentication, ["type", "headers"])
  ) {
    return undefined;
  }
  const headers = snapshotStringRecord(
    authentication.headers,
    (name) => HTTP_HEADER_NAME.test(name) && !isForbiddenCustomHeader(name),
    (headerValue) => !headerValue.includes("\r") && !headerValue.includes("\n"),
  );
  if (headers === undefined || Object.keys(headers).length === 0)
    return undefined;
  const uniqueNames = new Set<string>();
  for (const name of Object.keys(headers)) {
    const normalized = name.toLowerCase();
    if (uniqueNames.has(normalized)) return undefined;
    uniqueNames.add(normalized);
  }
  return headers;
}

function snapshotTarget(target: McpClientTarget): TargetSnapshot {
  try {
    const record = dataProperties(target);
    if (record === undefined || typeof record.transport !== "string") {
      throw new ClientBoundaryFailure("INVALID_TARGET");
    }
    if (record.transport === "stdio") {
      if (
        !hasExactlyKeys(
          record,
          ["transport", "command"],
          ["args", "cwd", "env"],
        ) ||
        typeof record.command !== "string" ||
        record.command.length === 0
      ) {
        throw new ClientBoundaryFailure("INVALID_TARGET");
      }
      const args =
        record.args === undefined ? [] : snapshotStringArray(record.args);
      const env =
        record.env === undefined
          ? {}
          : snapshotStringRecord(
              record.env,
              (name) => ENVIRONMENT_NAME.test(name),
              (entry) => entry.length > 0,
            );
      if (
        args === undefined ||
        env === undefined ||
        (record.cwd !== undefined &&
          (typeof record.cwd !== "string" || record.cwd.length === 0))
      ) {
        throw new ClientBoundaryFailure("INVALID_TARGET");
      }
      return {
        transport: "stdio",
        command: record.command,
        args,
        ...(record.cwd === undefined ? {} : { cwd: record.cwd as string }),
        env,
      };
    }
    if (record.transport === "http") {
      if (!hasExactlyKeys(record, ["transport", "url"], ["authentication"])) {
        throw new ClientBoundaryFailure("INVALID_TARGET");
      }
      const url = parseCanonicalHttpUrl(record.url);
      const credentials = snapshotAuthentication(record.authentication);
      if (url === undefined || credentials === undefined) {
        throw new ClientBoundaryFailure("INVALID_TARGET");
      }
      return { transport: "http", url, credentials };
    }
    throw new ClientBoundaryFailure("INVALID_TARGET");
  } catch (cause) {
    if (cause instanceof ClientBoundaryFailure)
      throw clientError(cause.code, cause);
    throw clientError("INVALID_TARGET", cause);
  }
}

function snapshotAbortSignal(
  options: McpClientOperationOptions | undefined,
  invalidCode: Extract<McpClientErrorCode, "INVALID_TARGET" | "PROTOCOL_ERROR">,
): AbortSignal | undefined {
  try {
    if (options === undefined) return undefined;
    const record = dataProperties(options);
    if (record === undefined || !hasExactlyKeys(record, [], ["signal"])) {
      throw new ClientBoundaryFailure(invalidCode);
    }
    if (record.signal === undefined) return undefined;
    if (
      typeof record.signal !== "object" ||
      record.signal === null ||
      nodeTypes.isProxy(record.signal)
    ) {
      throw new ClientBoundaryFailure(invalidCode);
    }
    Reflect.apply(AbortSignal.prototype.throwIfAborted, record.signal, []);
    return record.signal as AbortSignal;
  } catch (cause) {
    if (cause instanceof ClientBoundaryFailure)
      throw clientError(cause.code, cause);
    if (isAbortedSignal(options)) throw clientError("CANCELLED", cause);
    throw clientError(invalidCode, cause);
  }
}

function isAbortedSignal(
  options: McpClientOperationOptions | undefined,
): boolean {
  try {
    const descriptor =
      options === undefined
        ? undefined
        : Object.getOwnPropertyDescriptor(options, "signal");
    if (descriptor === undefined || !("value" in descriptor)) return false;
    const signal = descriptor.value;
    if (
      typeof signal !== "object" ||
      signal === null ||
      nodeTypes.isProxy(signal)
    ) {
      return false;
    }
    Reflect.apply(AbortSignal.prototype.throwIfAborted, signal, []);
    return false;
  } catch {
    return true;
  }
}

function snapshotJson(value: unknown): McpJsonValue {
  const active = new Set<object>();
  const visit = (entry: unknown): McpJsonValue => {
    if (
      entry === null ||
      typeof entry === "string" ||
      typeof entry === "boolean"
    ) {
      return entry;
    }
    if (typeof entry === "number") {
      if (!Number.isFinite(entry) || Object.is(entry, -0)) {
        throw new ClientBoundaryFailure("PROTOCOL_ERROR");
      }
      return entry;
    }
    if (typeof entry !== "object" || nodeTypes.isProxy(entry)) {
      throw new ClientBoundaryFailure("PROTOCOL_ERROR");
    }
    if (active.has(entry)) throw new ClientBoundaryFailure("PROTOCOL_ERROR");
    active.add(entry);
    try {
      if (Array.isArray(entry)) {
        const descriptors = Object.getOwnPropertyDescriptors(entry);
        const lengthDescriptor = Reflect.getOwnPropertyDescriptor(
          entry,
          "length",
        );
        const length =
          lengthDescriptor !== undefined && "value" in lengthDescriptor
            ? lengthDescriptor.value
            : undefined;
        if (typeof length !== "number") {
          throw new ClientBoundaryFailure("PROTOCOL_ERROR");
        }
        const snapshot: McpJsonValue[] = [];
        for (let index = 0; index < length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (
            descriptor === undefined ||
            !descriptor.enumerable ||
            !("value" in descriptor)
          ) {
            throw new ClientBoundaryFailure("PROTOCOL_ERROR");
          }
          snapshot.push(visit(descriptor.value));
        }
        const expected = new Set([
          "length",
          ...snapshot.map((_, index) => String(index)),
        ]);
        if (
          Reflect.ownKeys(descriptors).some(
            (key) => typeof key !== "string" || !expected.has(key),
          )
        ) {
          throw new ClientBoundaryFailure("PROTOCOL_ERROR");
        }
        return snapshot;
      }
      const record = dataProperties(entry);
      if (record === undefined)
        throw new ClientBoundaryFailure("PROTOCOL_ERROR");
      const snapshot = createDataRecord<McpJsonValue>();
      for (const [key, child] of Object.entries(record)) {
        defineDataProperty(snapshot, key, visit(child));
      }
      return snapshot;
    } finally {
      active.delete(entry);
    }
  };
  const snapshot = visit(value);
  JSON.stringify(snapshot);
  return snapshot;
}

function snapshotJsonRecord(value: unknown): Record<string, McpJsonValue> {
  const snapshot = snapshotJson(value);
  if (
    Array.isArray(snapshot) ||
    snapshot === null ||
    typeof snapshot !== "object"
  ) {
    throw new ClientBoundaryFailure("PROTOCOL_ERROR");
  }
  return snapshot as Record<string, McpJsonValue>;
}

function encodedBytes(value: unknown, stdio: boolean): number {
  const serialized = JSON.stringify(value);
  return textEncoder.encode(stdio ? `${serialized}\n` : serialized).byteLength;
}

function checkMessageSize(value: unknown, stdio: boolean): void {
  if (encodedBytes(value, stdio) > MAX_MESSAGE_BYTES) {
    throw new ClientBoundaryFailure("LIMIT_EXCEEDED");
  }
}

function boundedResponseBody(response: Response): Response {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    /^\d+$/.test(declaredLength) &&
    Number(declaredLength) > MAX_MESSAGE_BYTES
  ) {
    void response.body?.cancel();
    throw new ClientBoundaryFailure("LIMIT_EXCEEDED");
  }
  if (response.body === null) return response;
  let received = 0;
  const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
  const bounded = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > MAX_MESSAGE_BYTES) {
          controller.error(new ClientBoundaryFailure("LIMIT_EXCEEDED"));
          return;
        }
        try {
          utf8Decoder.decode(chunk, { stream: true });
        } catch {
          controller.error(new ClientBoundaryFailure("PROTOCOL_ERROR"));
          return;
        }
        controller.enqueue(chunk);
      },
      flush() {
        try {
          utf8Decoder.decode();
        } catch {
          throw new ClientBoundaryFailure("PROTOCOL_ERROR");
        }
      },
    }),
  );
  return new Response(bounded, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function createSecureFetch(credentials: Record<string, string>) {
  return async (
    url: string | URL,
    init: RequestInit = {},
  ): Promise<Response> => {
    try {
      if (init.method === "GET") {
        return new Response(null, {
          status: 405,
          statusText: "Method Not Allowed",
        });
      }
      if (init.body !== undefined && init.body !== null) {
        if (typeof init.body !== "string") {
          throw new ClientBoundaryFailure("PROTOCOL_ERROR");
        }
        if (textEncoder.encode(init.body).byteLength > MAX_MESSAGE_BYTES) {
          throw new ClientBoundaryFailure("LIMIT_EXCEEDED");
        }
      }
      const headers = new Headers(init.headers);
      for (const [name, value] of Object.entries(credentials))
        headers.set(name, value);
      const response = await fetch(url, {
        ...init,
        headers,
        redirect: "manual",
      });
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        throw new ClientBoundaryFailure("AUTHENTICATION_FAILED");
      }
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new ClientBoundaryFailure("CONNECTION_FAILED");
      }
      return boundedResponseBody(response);
    } catch (cause) {
      if (cause instanceof ClientBoundaryFailure) throw cause;
      throw new ClientBoundaryFailure("CONNECTION_FAILED");
    }
  };
}

function recordConnectionFailure(
  state: ConnectionState,
  failure: ClientBoundaryFailure,
): void {
  if (
    state.failure === undefined ||
    failure.code === "LIMIT_EXCEEDED" ||
    state.failure.code === "PROTOCOL_ERROR"
  ) {
    state.failure = failure;
  }
}

class FacadeTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(
    message: T,
    extra?: MessageExtraInfo,
  ) => void;
  private initializeRequestId: string | number | undefined;
  protocolVersion: string | undefined;

  constructor(
    private readonly inner: Transport,
    private readonly stdio: boolean,
    private readonly state: ConnectionState,
  ) {
    inner.onclose = () => this.onclose?.();
    inner.onerror = (error) => {
      this.onerror?.(error);
      if (!this.state.connected) return;
      recordConnectionFailure(
        this.state,
        error instanceof ClientBoundaryFailure
          ? error
          : new ClientBoundaryFailure(
              error.message.startsWith("ReadBuffer exceeded maximum size of ")
                ? "LIMIT_EXCEEDED"
                : "PROTOCOL_ERROR",
            ),
      );
      void this.inner.close();
    };
    inner.onmessage = (message, extra) => {
      try {
        checkMessageSize(message, this.stdio);
        if (
          this.initializeRequestId !== undefined &&
          "id" in message &&
          message.id === this.initializeRequestId &&
          "result" in message &&
          isPlainRecord(message.result) &&
          typeof message.result.protocolVersion === "string"
        ) {
          this.protocolVersion = message.result.protocolVersion;
        }
        this.onmessage?.(message, extra);
      } catch (cause) {
        recordConnectionFailure(
          this.state,
          cause instanceof ClientBoundaryFailure
            ? cause
            : new ClientBoundaryFailure("PROTOCOL_ERROR"),
        );
        void this.inner.close();
      }
    };
  }

  setProtocolVersion(version: string): void {
    this.inner.setProtocolVersion?.(version);
  }

  async start(): Promise<void> {
    await this.inner.start();
    this.state.connected = true;
  }

  async send(
    message: JSONRPCMessage,
    options?: TransportSendOptions,
  ): Promise<void> {
    checkMessageSize(message, this.stdio);
    if (
      "method" in message &&
      message.method === "initialize" &&
      "id" in message &&
      (typeof message.id === "string" || typeof message.id === "number")
    ) {
      this.initializeRequestId = message.id;
    }
    await this.inner.send(message, options);
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}

function normalizeFailure(
  cause: unknown,
  state: ConnectionState,
  signal: AbortSignal | undefined,
  connectingStdio: boolean,
): McpClientError {
  if (cause instanceof McpClientError) return cause;
  if (signal?.aborted) return clientError("CANCELLED", cause);
  if (state.failure !== undefined)
    return clientError(state.failure.code, cause);
  if (cause instanceof ClientBoundaryFailure)
    return clientError(cause.code, cause);
  if (cause instanceof McpError && cause.code === ErrorCode.RequestTimeout) {
    return clientError("TIMEOUT", cause);
  }
  if (state.closing) return clientError("CANCELLED", cause);
  if (connectingStdio && !state.connected)
    return clientError("SPAWN_FAILED", cause);
  if (cause instanceof McpError && cause.code === ErrorCode.ConnectionClosed) {
    return clientError("CONNECTION_FAILED", cause);
  }
  return clientError(
    state.connected ? "PROTOCOL_ERROR" : "CONNECTION_FAILED",
    cause,
  );
}

function clearRecord(record: Record<string, string>): void {
  for (const key of Object.keys(record)) delete record[key];
}

function mapTool(value: unknown): McpClientTool {
  const tool = snapshotJsonRecord(value);
  if (
    typeof tool.name !== "string" ||
    tool.name.length === 0 ||
    typeof tool.inputSchema !== "object" ||
    tool.inputSchema === null ||
    Array.isArray(tool.inputSchema) ||
    (tool.title !== undefined && typeof tool.title !== "string") ||
    (tool.description !== undefined && typeof tool.description !== "string") ||
    (tool.outputSchema !== undefined &&
      (typeof tool.outputSchema !== "object" ||
        tool.outputSchema === null ||
        Array.isArray(tool.outputSchema))) ||
    (tool.annotations !== undefined &&
      (typeof tool.annotations !== "object" ||
        tool.annotations === null ||
        Array.isArray(tool.annotations)))
  ) {
    throw new ClientBoundaryFailure("PROTOCOL_ERROR");
  }
  return {
    name: tool.name,
    ...(tool.title === undefined ? {} : { title: tool.title }),
    ...(tool.description === undefined
      ? {}
      : { description: tool.description }),
    inputSchema: tool.inputSchema as Record<string, McpJsonValue>,
    ...(tool.outputSchema === undefined
      ? {}
      : { outputSchema: tool.outputSchema as Record<string, McpJsonValue> }),
    ...(tool.annotations === undefined
      ? {}
      : { annotations: tool.annotations as Record<string, McpJsonValue> }),
  };
}

export async function connectMcpClient(
  target: McpClientTarget,
  options?: McpClientOperationOptions,
): Promise<McpClientConnection> {
  const snapshot = snapshotTarget(target);
  const signal = snapshotAbortSignal(options, "INVALID_TARGET");
  const state: ConnectionState = { closing: false, connected: false };
  const client = new Client(
    { name: CLIENT_NAME, version: CLIENT_VERSION },
    { capabilities: {}, enforceStrictCapabilities: true },
  );
  const inner =
    snapshot.transport === "stdio"
      ? new StdioClientTransport({
          command: snapshot.command,
          args: snapshot.args,
          env: snapshot.env,
          ...(snapshot.cwd === undefined ? {} : { cwd: snapshot.cwd }),
          stderr: "pipe",
          maxBufferSize: MAX_MESSAGE_BYTES,
        })
      : new StreamableHTTPClientTransport(snapshot.url, {
          fetch: createSecureFetch(snapshot.credentials),
          reconnectionOptions: {
            initialReconnectionDelay: 1,
            maxReconnectionDelay: 1,
            reconnectionDelayGrowFactor: 1,
            maxRetries: 0,
          },
        });
  if (inner instanceof StdioClientTransport) {
    inner.stderr?.on("data", () => undefined);
  }
  const transport = new FacadeTransport(
    inner as unknown as Transport,
    snapshot.transport === "stdio",
    state,
  );
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      state.closing = true;
      try {
        await client.close();
      } catch (cause) {
        throw cause instanceof ClientBoundaryFailure
          ? clientError(cause.code, cause)
          : clientError("CONNECTION_FAILED", cause);
      } finally {
        clearRecord(
          snapshot.transport === "stdio" ? snapshot.env : snapshot.credentials,
        );
      }
    })();
    return closePromise;
  };

  try {
    await client.connect(
      transport,
      signal === undefined ? undefined : { signal },
    );
    const version = client.getServerVersion();
    const protocolVersion = transport.protocolVersion;
    const capabilities = snapshotJsonRecord(
      client.getServerCapabilities() ?? {},
    );
    const instructions = client.getInstructions();
    if (
      version === undefined ||
      typeof version.name !== "string" ||
      typeof version.version !== "string" ||
      typeof protocolVersion !== "string" ||
      (instructions !== undefined && typeof instructions !== "string")
    ) {
      throw new ClientBoundaryFailure("PROTOCOL_ERROR");
    }
    const server: McpClientServerInfo = {
      name: version.name,
      version: version.version,
      protocolVersion,
      ...(instructions === undefined ? {} : { instructions }),
      capabilities,
    };

    const runOperation = async <Result>(
      operationOptions: McpClientOperationOptions | undefined,
      operation: (operationSignal: AbortSignal | undefined) => Promise<Result>,
    ): Promise<Result> => {
      const operationSignal = snapshotAbortSignal(
        operationOptions,
        "PROTOCOL_ERROR",
      );
      if (state.closing) throw clientError("CANCELLED");
      try {
        return await operation(operationSignal);
      } catch (cause) {
        const failure = normalizeFailure(cause, state, operationSignal, false);
        if (failure.code === "LIMIT_EXCEEDED")
          await close().catch(() => undefined);
        throw failure;
      }
    };

    return {
      server,
      async listTools(cursor, operationOptions) {
        if (cursor !== undefined && typeof cursor !== "string") {
          throw clientError("PROTOCOL_ERROR");
        }
        return runOperation(operationOptions, async (operationSignal) => {
          const result = await client.listTools(
            cursor === undefined ? undefined : { cursor },
            operationSignal === undefined
              ? undefined
              : { signal: operationSignal },
          );
          const tools = result.tools.map(mapTool);
          if (
            result.nextCursor !== undefined &&
            typeof result.nextCursor !== "string"
          ) {
            throw new ClientBoundaryFailure("PROTOCOL_ERROR");
          }
          return {
            tools,
            ...(result.nextCursor === undefined
              ? {}
              : { nextCursor: result.nextCursor }),
          };
        });
      },
      async callTool(name, argumentsValue, operationOptions) {
        if (typeof name !== "string" || name.length === 0) {
          throw clientError("PROTOCOL_ERROR");
        }
        let argumentsSnapshot: Record<string, McpJsonValue> | undefined;
        try {
          argumentsSnapshot =
            argumentsValue === undefined
              ? undefined
              : snapshotJsonRecord(argumentsValue);
        } catch (cause) {
          throw clientError("PROTOCOL_ERROR", cause);
        }
        return runOperation(operationOptions, async (operationSignal) => {
          const result = await client.callTool(
            {
              name,
              ...(argumentsSnapshot === undefined
                ? {}
                : { arguments: argumentsSnapshot }),
            },
            undefined,
            operationSignal === undefined
              ? undefined
              : { signal: operationSignal },
          );
          return { response: snapshotJsonRecord(result) };
        });
      },
      close,
    };
  } catch (cause) {
    const failure = normalizeFailure(
      cause,
      state,
      signal,
      snapshot.transport === "stdio",
    );
    await close().catch(() => undefined);
    throw failure;
  }
}
