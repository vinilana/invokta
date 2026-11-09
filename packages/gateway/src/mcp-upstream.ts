import { type CapabilityAnnotations, CapabilityError } from "@invokta/core";

import {
  isJsonObject,
  type JsonObject,
  type JsonSchemaValidator,
  jsonSchemaContract,
} from "./json-schema-contract.js";
import { assertName, selectIncluded } from "./patterns.js";
import type {
  GatewayUpstream,
  GatewayUpstreamCapability,
  GatewayUpstreamRoute,
} from "./types.js";
import { registerUpstream } from "./upstream-registry.js";

/** One tool as an MCP client lists it. `McpClientTool` from `@invokta/mcp` fits. */
export interface GatewayMcpTool {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: JsonObject;
  readonly outputSchema?: JsonObject;
  readonly annotations?: JsonObject;
}

/**
 * The MCP client operations the gateway uses. The `McpClientConnection`
 * returned by `connectMcpClient` from `@invokta/mcp` satisfies it, so the
 * gateway does not depend on the MCP SDK.
 */
export interface GatewayMcpConnection {
  listTools(
    cursor?: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<{
    readonly tools: ReadonlyArray<GatewayMcpTool>;
    readonly nextCursor?: string;
  }>;
  callTool(
    name: string,
    argumentsValue?: JsonObject,
    options?: { readonly signal?: AbortSignal },
  ): Promise<{ readonly response: JsonObject }>;
}

export interface McpUpstreamOptions {
  /** Unique upstream name used in routes, decisions, and diagnostics. */
  readonly name: string;
  /** A connected MCP client. The host owns its credentials and lifetime. */
  readonly connection: GatewayMcpConnection;
  /** The gateway publishes `<namespace>.<tool name>`. Defaults to `name`. */
  readonly namespace?: string;
  /** Tool name patterns to publish. Defaults to every listed tool. */
  readonly include?: ReadonlyArray<string>;
  /** Finite timeout of every tool call. Defaults to 30,000 ms. */
  readonly timeoutMs?: number;
  /** Maximum listed tools before discovery fails. Defaults to 256. */
  readonly maxTools?: number;
  /** Expected catalog fingerprint; discovery fails when the catalog differs. */
  readonly pin?: string;
  /**
   * Trust every annotation hint of this server. Defaults to `false`: an
   * untrusted hint is republished only when it makes a tool look riskier,
   * and it never makes a tool read-only.
   */
  readonly trustAnnotations?: boolean;
  /** Tool names the operator vouches are read-only, whatever their hints. */
  readonly readOnlyTools?: ReadonlyArray<string>;
  /**
   * Validates input and structured results against each tool's schemas, so
   * invalid input fails as `INPUT_INVALID` before the call. Without one, the
   * gateway checks only that values are JSON objects and the MCP server
   * validates its own input.
   */
  readonly validator?: JsonSchemaValidator;
  /** Cancels catalog discovery. */
  readonly signal?: AbortSignal;
}

export interface McpGatewayUpstream extends GatewayUpstream {
  readonly kind: "mcp";
  /** SHA-256 of the canonical JSON of the published tools, sorted by name. */
  readonly fingerprint: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAXIMUM_TIMEOUT_MS = 2_147_483_647;
const DEFAULT_MAX_TOOLS = 256;
const MAXIMUM_MAX_TOOLS = 4_096;
const MAXIMUM_PAGES = 64;
const MAXIMUM_ERROR_MESSAGE_LENGTH = 1_024;
const FINGERPRINT = /^[0-9a-f]{64}$/u;

/** Output contract of a tool that publishes no output schema. */
const CONTENT_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    content: {
      type: "array",
      description: "The MCP content blocks returned by the upstream tool.",
      items: { type: "object" },
    },
  },
  required: ["content"],
});

const UPSTREAM_TOOL_ERROR = Object.freeze({
  description: "The upstream MCP tool reported an error.",
  retryable: false,
  details: jsonSchemaContract({
    type: "object",
    properties: { message: { type: "string", maxLength: 1_024 } },
    required: ["message"],
    additionalProperties: false,
  }),
});

/** MCP hint, core annotation, and the value that signals more caution. */
const ANNOTATION_HINTS = Object.freeze([
  ["readOnlyHint", "readOnly", false],
  ["destructiveHint", "destructive", true],
  ["idempotentHint", "idempotent", false],
  ["openWorldHint", "openWorld", true],
] as const);

/**
 * Publishes the tools of a connected MCP server through the gateway.
 *
 * Discovery runs once, at the composition root, with bounded pagination. The
 * resulting catalog is frozen: the gateway never re-lists tools at runtime, so
 * an upstream cannot add or change a published tool without a restart, and a
 * configured `pin` turns any change into a startup failure.
 */
export async function mcpUpstream(
  options: McpUpstreamOptions,
): Promise<McpGatewayUpstream> {
  const name = assertName(options.name, "Upstream name");
  const namespace = assertName(
    options.namespace ?? name,
    `Upstream ${name} namespace`,
  );
  const timeoutMs = boundedInteger(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    1,
    MAXIMUM_TIMEOUT_MS,
    `Upstream ${name} timeoutMs`,
  );
  const maxTools = boundedInteger(
    options.maxTools ?? DEFAULT_MAX_TOOLS,
    1,
    MAXIMUM_MAX_TOOLS,
    `Upstream ${name} maxTools`,
  );
  if (options.pin !== undefined && !FINGERPRINT.test(options.pin)) {
    throw new TypeError(
      `Upstream ${name} pin must be a lowercase SHA-256 hex digest.`,
    );
  }
  const connection = options.connection;
  const trustAnnotations = options.trustAnnotations ?? false;
  if (typeof trustAnnotations !== "boolean") {
    throw new TypeError(`Upstream ${name} trustAnnotations must be a boolean.`);
  }
  const readOnlyTools = snapshotToolNames(options.readOnlyTools, name);
  const validator = options.validator;
  if (validator !== undefined && typeof validator !== "function") {
    throw new TypeError(`Upstream ${name} validator must be a function.`);
  }

  const listed = await listAllTools(connection, name, maxTools, options.signal);
  const byName = new Map(listed.map((tool) => [tool.name, tool]));
  const selected = selectIncluded(
    [...byName.keys()],
    options.include,
    name,
  ).map((toolName) => byName.get(toolName) as GatewayMcpTool);
  for (const toolName of readOnlyTools) {
    if (!selected.some((tool) => tool.name === toolName)) {
      throw new TypeError(
        `MCP upstream ${name} readOnlyTools names unknown tool ${toolName}.`,
      );
    }
  }
  const fingerprint = await fingerprintTools(selected);
  if (options.pin !== undefined && options.pin !== fingerprint) {
    throw new Error(
      `MCP upstream ${name} tool catalog does not match the pinned fingerprint.`,
    );
  }

  const capabilities = selected.map((tool): GatewayUpstreamCapability => {
    const vouched = readOnlyTools.has(tool.name);
    const annotations = mapAnnotations(
      tool.annotations,
      trustAnnotations,
      vouched,
    );
    const route: GatewayUpstreamRoute = Object.freeze({
      capabilityId: `${namespace}.${tool.name}`,
      upstream: name,
      kind: "mcp",
      upstreamCapabilityId: tool.name,
      readOnly: annotations?.readOnly === true,
    });
    if (tool.inputSchema.type !== "object") {
      throw new TypeError(
        `MCP upstream ${name} tool ${tool.name} input schema must have an object root.`,
      );
    }
    if (
      tool.outputSchema !== undefined &&
      tool.outputSchema.type !== "object"
    ) {
      throw new TypeError(
        `MCP upstream ${name} tool ${tool.name} output schema must have an object root.`,
      );
    }
    const structured = tool.outputSchema !== undefined;
    return Object.freeze({
      route,
      ...(tool.title === undefined ? {} : { title: tool.title }),
      description:
        tool.description === undefined || tool.description.trim() === ""
          ? `Tool ${tool.name} published by the ${name} MCP upstream.`
          : tool.description,
      input: jsonSchemaContract(tool.inputSchema, validator),
      output: jsonSchemaContract(
        tool.outputSchema ?? CONTENT_OUTPUT_SCHEMA,
        validator,
      ),
      timeoutMs,
      ...(annotations === undefined ? {} : { annotations }),
      errors: Object.freeze({ UPSTREAM_TOOL_ERROR }),
      async run({ input, context }) {
        const { response } = await connection.callTool(tool.name, input, {
          signal: context.signal,
        });
        if (response.isError === true) {
          throw new CapabilityError("UPSTREAM_TOOL_ERROR", {
            details: { message: errorMessage(response.content) },
          });
        }
        if (structured) {
          if (!isJsonObject(response.structuredContent)) {
            throw new TypeError(
              "The upstream tool omitted its structured result.",
            );
          }
          return response.structuredContent;
        }
        return {
          content: Array.isArray(response.content) ? response.content : [],
        };
      },
    } satisfies GatewayUpstreamCapability);
  });

  return registerUpstream(name, "mcp", capabilities, {
    fingerprint,
  }) as McpGatewayUpstream;
}

async function listAllTools(
  connection: GatewayMcpConnection,
  name: string,
  maxTools: number,
  signal: AbortSignal | undefined,
): Promise<ReadonlyArray<GatewayMcpTool>> {
  const tools: GatewayMcpTool[] = [];
  const names = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAXIMUM_PAGES; page += 1) {
    const result = await connection.listTools(
      cursor,
      signal === undefined ? undefined : { signal },
    );
    for (const tool of result.tools) {
      if (tools.length === maxTools) {
        throw new Error(
          `MCP upstream ${name} lists more than the configured maximum of ${String(maxTools)} tools.`,
        );
      }
      if (names.has(tool.name)) {
        throw new Error(`MCP upstream ${name} lists tool ${tool.name} twice.`);
      }
      names.add(tool.name);
      tools.push(tool);
    }
    if (result.nextCursor === undefined) return tools;
    cursor = result.nextCursor;
  }
  throw new Error(
    `MCP upstream ${name} paginates beyond ${String(MAXIMUM_PAGES)} tool pages.`,
  );
}

/**
 * Maps MCP hints to core annotations. MCP clients must treat hints from an
 * untrusted server as untrusted, so without trust only values that make a
 * tool look riskier survive; a tool the operator vouches for is read-only.
 */
function mapAnnotations(
  hints: JsonObject | undefined,
  trusted: boolean,
  vouchedReadOnly: boolean,
): CapabilityAnnotations | undefined {
  const annotations: Record<string, boolean> = {};
  for (const [hint, annotation, cautious] of ANNOTATION_HINTS) {
    const value = hints?.[hint];
    if (typeof value === "boolean" && (trusted || value === cautious)) {
      annotations[annotation] = value;
    }
  }
  if (vouchedReadOnly) {
    annotations.readOnly = true;
    delete annotations.destructive;
  }
  return Object.keys(annotations).length === 0
    ? undefined
    : Object.freeze(annotations);
}

function snapshotToolNames(
  value: unknown,
  upstream: string,
): ReadonlySet<string> {
  if (value === undefined) return new Set();
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry === "")
  ) {
    throw new TypeError(
      `Upstream ${upstream} readOnlyTools must list tool names.`,
    );
  }
  return new Set(value as string[]);
}

function errorMessage(content: unknown): string {
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        isJsonObject(block) &&
        block.type === "text" &&
        typeof block.text === "string" &&
        block.text !== ""
      ) {
        return block.text.slice(0, MAXIMUM_ERROR_MESSAGE_LENGTH);
      }
    }
  }
  return "The upstream MCP tool failed.";
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new TypeError(
      `${label} must be an integer from ${String(minimum)} through ${String(maximum)}.`,
    );
  }
  return value;
}

async function fingerprintTools(
  tools: ReadonlyArray<GatewayMcpTool>,
): Promise<string> {
  const canonical = [...tools]
    .sort((left, right) => (left.name < right.name ? -1 : 1))
    .map((tool) => ({
      name: tool.name,
      title: tool.title ?? null,
      description: tool.description ?? null,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema ?? null,
      annotations: tool.annotations ?? null,
    }));
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(canonical)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** JSON with object keys sorted at every level, so key order cannot change a fingerprint. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isJsonObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
