import {
  type AnyCapability,
  CapabilityError,
  type CapabilityMap,
  createEngine,
  type DomainErrorPublicDetails,
  type Engine,
  EngineError,
  type EngineEvent,
  type EngineLogger,
  type ExecutionContext,
  type Principal,
} from "@invokta/core";

import { engineUpstream } from "./engine-upstream.js";
import type { Gateway } from "./gateway.js";
import {
  checkedContract,
  isJsonObject,
  type JsonObject,
  jsonSchemaContract,
} from "./json-schema-contract.js";
import { assertName, compilePatterns } from "./patterns.js";
import { createSearchIndex } from "./search-index.js";
import type { GatewayVisibility } from "./types.js";
import { upstreamCapabilities } from "./upstream-registry.js";

/** One visible capability as a host ranker receives it. */
export interface DiscoveryCandidate {
  readonly id: string;
  readonly title?: string;
  readonly description: string;
}

/**
 * A host-owned ranker, for example embedding search. It may reorder or drop
 * candidates; IDs outside the candidates are ignored.
 */
export type DiscoveryRanker = (
  query: string,
  candidates: ReadonlyArray<DiscoveryCandidate>,
  options: { readonly signal: AbortSignal },
) => Promise<ReadonlyArray<string>>;

/** One search, without the query text, which may contain sensitive data. */
export interface DiscoverySearchEvent {
  readonly requestId: string;
  readonly principalId?: string;
  readonly resultCount: number;
  readonly truncated: boolean;
  readonly ranker: "lexical" | "custom" | "lexical-fallback";
}

export interface DiscoveryOptions {
  readonly gateway: Gateway;
  /** Prefix of the discovery capability IDs. Defaults to `gateway`. */
  readonly prefix?: string;
  /** Gateway capability patterns also published directly, at most 32. */
  readonly alwaysList?: ReadonlyArray<string>;
  /** Language the model should search in. Defaults to `English`. */
  readonly queryLanguage?: string;
  readonly rank?: DiscoveryRanker;
  /** Ranker deadline before falling back to lexical search. Defaults to 2,000 ms. */
  readonly rankTimeoutMs?: number;
  /** Receives every search. Failures and returned promises are ignored. */
  readonly onSearch?: (event: DiscoverySearchEvent) => void | Promise<void>;
  /** Definition of the internal engine over `gateway.capabilities`. */
  readonly gatewayEngine?: {
    readonly name?: string;
    readonly version?: string;
    readonly logger?: EngineLogger;
    readonly onEvent?: (event: EngineEvent) => void | Promise<void>;
  };
}

export interface Discovery {
  /** The discovery tools plus `alwaysList`; serve them as their own engine. */
  readonly capabilities: CapabilityMap;
  /** The `visibility` option for the adapters serving `capabilities`. */
  readonly visibility: GatewayVisibility;
  /**
   * The engine over `gateway.capabilities` that every invocation goes
   * through. It may also serve the full catalog to clients that search
   * tools on their own.
   */
  readonly gatewayEngine: Engine;
}

interface CatalogEntry {
  readonly id: string;
  readonly readOnly: boolean;
  readonly candidate: DiscoveryCandidate;
  readonly published: JsonObject;
  readonly bytes: number;
}

const MAX_ALWAYS_LIST = 32;
const MAX_QUERY_LENGTH = 256;
const MAX_TOOL_ID_LENGTH = 256;
const MAX_RESULTS = 20;
const DEFAULT_RESULTS = 8;
const RESPONSE_BUDGET_BYTES = 65_536;
const RESPONSE_ENVELOPE_BYTES = 32;
const DEFAULT_RANK_TIMEOUT_MS = 2_000;
const MAX_RANK_TIMEOUT_MS = 60_000;

const encoder = new TextEncoder();
const toolDetails = jsonSchemaContract({
  type: "object",
  properties: { tool: { type: "string" } },
  required: ["tool"],
  additionalProperties: false,
});
const NOT_FOUND = Object.freeze({
  description: "No visible tool has this ID. Search again with search-tools.",
  retryable: false,
  details: toolDetails,
});
const NOT_READ_ONLY = Object.freeze({
  description:
    "This tool is not trusted to be read-only. Call it with invoke-tool.",
  retryable: false,
  details: toolDetails,
});
const TARGET_DOMAIN_ERROR = Object.freeze({
  description: "The tool raised one of its declared domain errors.",
  retryable: false,
  details: jsonSchemaContract({
    type: "object",
    properties: {
      tool: { type: "string" },
      code: { type: "string" },
      retryable: { type: "boolean" },
      details: { type: "object" },
    },
    required: ["tool", "code", "retryable"],
    additionalProperties: false,
  }),
});

const searchInput = checkedContract(
  {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1, maxLength: MAX_QUERY_LENGTH },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: MAX_RESULTS,
        default: DEFAULT_RESULTS,
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  (value) => {
    if (Object.keys(value).some((key) => key !== "query" && key !== "limit")) {
      return "Only query and limit are accepted.";
    }
    const { query, limit } = value;
    if (
      typeof query !== "string" ||
      query.trim() === "" ||
      query.length > MAX_QUERY_LENGTH
    ) {
      return `query must be a non-blank string of at most ${String(MAX_QUERY_LENGTH)} characters.`;
    }
    if (
      limit !== undefined &&
      (typeof limit !== "number" ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > MAX_RESULTS)
    ) {
      return `limit must be an integer from 1 through ${String(MAX_RESULTS)}.`;
    }
    return undefined;
  },
);

const searchOutput = jsonSchemaContract({
  type: "object",
  properties: {
    tools: {
      type: "array",
      items: { type: "object" },
      description:
        "Matching tools with their ID, title, description, schemas, annotations, and deprecation.",
    },
    truncated: {
      type: "boolean",
      description: "Whether more matches were dropped to stay within 64 KiB.",
    },
  },
  required: ["tools", "truncated"],
});

const invokeInput = checkedContract(
  {
    type: "object",
    properties: {
      tool: {
        type: "string",
        minLength: 1,
        maxLength: MAX_TOOL_ID_LENGTH,
        description: "The tool ID returned by search-tools.",
      },
      arguments: {
        type: "object",
        description: "The tool input, matching its inputSchema.",
      },
    },
    required: ["tool"],
    additionalProperties: false,
  },
  (value) => {
    if (
      Object.keys(value).some((key) => key !== "tool" && key !== "arguments")
    ) {
      return "Only tool and arguments are accepted.";
    }
    if (
      typeof value.tool !== "string" ||
      value.tool === "" ||
      value.tool.length > MAX_TOOL_ID_LENGTH
    ) {
      return `tool must be a tool ID of at most ${String(MAX_TOOL_ID_LENGTH)} characters.`;
    }
    if (value.arguments !== undefined && !isJsonObject(value.arguments)) {
      return "arguments must be a JSON object.";
    }
    return undefined;
  },
);

const invokeOutput = jsonSchemaContract({
  type: "object",
  properties: {
    result: { type: "object", description: "The tool's output." },
  },
  required: ["result"],
});

/**
 * Builds search-based discovery over a gateway: a client sees
 * `search-tools`, `invoke-read-tool`, and `invoke-tool` (plus `alwaysList`)
 * whatever the catalog size.
 *
 * Every invocation goes through an engine built here from
 * `gateway.capabilities`, so the target's gateway rule, upstream validation
 * and access, timeout, events, and authorization decision apply exactly as
 * for a direct call. Search and invocation only ever see capabilities that
 * `gateway.visibility` shows to the caller.
 */
export function createDiscovery(options: DiscoveryOptions): Discovery {
  const { gateway } = options;
  if (
    typeof gateway !== "object" ||
    gateway === null ||
    typeof gateway.visibility !== "function" ||
    !Array.isArray(gateway.routes)
  ) {
    throw new TypeError(
      "createDiscovery needs the value createGateway returned.",
    );
  }
  const prefix = assertName(options.prefix ?? "gateway", "Discovery prefix");
  const language = options.queryLanguage ?? "English";
  if (
    typeof language !== "string" ||
    language.trim() === "" ||
    language.length > 64
  ) {
    throw new TypeError("Discovery queryLanguage must be 1-64 characters.");
  }
  const rank = options.rank;
  if (rank !== undefined && typeof rank !== "function") {
    throw new TypeError("Discovery rank must be a function.");
  }
  const rankTimeoutMs = options.rankTimeoutMs ?? DEFAULT_RANK_TIMEOUT_MS;
  if (
    !Number.isInteger(rankTimeoutMs) ||
    rankTimeoutMs < 1 ||
    rankTimeoutMs > MAX_RANK_TIMEOUT_MS
  ) {
    throw new TypeError(
      `Discovery rankTimeoutMs must be an integer from 1 through ${String(MAX_RANK_TIMEOUT_MS)}.`,
    );
  }
  const onSearch = options.onSearch;
  if (onSearch !== undefined && typeof onSearch !== "function") {
    throw new TypeError("Discovery onSearch must be a function.");
  }

  const definition = options.gatewayEngine ?? {};
  const inner = createEngine({
    name: definition.name ?? "gateway",
    version: definition.version ?? "0.0.0",
    capabilities: gateway.capabilities,
    ...(definition.logger === undefined ? {} : { logger: definition.logger }),
    ...(definition.onEvent === undefined
      ? {}
      : { onEvent: definition.onEvent }),
  });

  const catalog = gateway.routes.map((route): CatalogEntry => {
    const described = inner.describe(route.capabilityId);
    const published: JsonObject = Object.freeze({
      id: described.id,
      ...(described.title === undefined ? {} : { title: described.title }),
      description: described.description,
      inputSchema: described.inputSchema,
      outputSchema: described.outputSchema,
      ...(described.annotations === undefined
        ? {}
        : { annotations: described.annotations }),
      ...(described.deprecated === undefined
        ? {}
        : { deprecated: described.deprecated }),
    });
    return Object.freeze({
      id: route.capabilityId,
      readOnly: route.readOnly,
      candidate: Object.freeze({
        id: described.id,
        ...(described.title === undefined ? {} : { title: described.title }),
        description: described.description,
      }),
      published,
      bytes: encoder.encode(JSON.stringify(published)).length,
    });
  });
  const byId = new Map(catalog.map((entry) => [entry.id, entry]));
  const index = createSearchIndex(catalog.map((entry) => entry.candidate));

  const ids = {
    search: `${prefix}.search-tools`,
    invokeRead: `${prefix}.invoke-read-tool`,
    invoke: `${prefix}.invoke-tool`,
  } as const;
  const discoveryIds = new Set<string>(Object.values(ids));

  const visibleFor = (context: ExecutionContext) => {
    const principal = freezeClone(context.principal);
    return (capabilityId: string): boolean =>
      gateway.visibility({ principal, capabilityId });
  };

  const report = (event: DiscoverySearchEvent): void => {
    if (onSearch === undefined) return;
    try {
      const pending = onSearch(Object.freeze(event));
      if (pending instanceof Promise) pending.catch(() => undefined);
    } catch {
      // An audit sink cannot change a search result.
    }
  };

  const searchTools: AnyCapability = Object.freeze({
    title: "Search tools",
    description: [
      `Search the gateway's tool catalog and return the matching tools with their input and output schemas.`,
      `Write the query as a few keywords for the action and the object in ${language}${language === "English" ? ', for example "cancel order"' : ""}.`,
      `Then call a read-only tool with ${ids.invokeRead} and any other tool with ${ids.invoke}.`,
    ].join(" "),
    input: searchInput,
    output: searchOutput,
    access: "public",
    annotations: Object.freeze({ readOnly: true }),
    async run({
      input,
      context,
    }: {
      input: JsonObject;
      context: ExecutionContext;
    }) {
      const query = input.query as string;
      const limit = (input.limit as number | undefined) ?? DEFAULT_RESULTS;
      const visible = visibleFor(context);
      const candidates = catalog.filter((entry) => visible(entry.id));
      const candidateIds = new Set(candidates.map((entry) => entry.id));

      let ordered: ReadonlyArray<string>;
      let ranker: DiscoverySearchEvent["ranker"] = "lexical";
      if (rank === undefined) {
        ordered = index.search(query, candidateIds);
      } else {
        try {
          ordered = await withDeadline(
            (signal) =>
              rank(
                query,
                candidates.map((entry) => entry.candidate),
                { signal },
              ),
            context.signal,
            rankTimeoutMs,
          );
          if (
            !Array.isArray(ordered) ||
            ordered.some((id) => typeof id !== "string")
          ) {
            throw new TypeError("The ranker returned a non-string ID.");
          }
          ranker = "custom";
        } catch (error) {
          if (context.signal.aborted) throw error;
          ordered = index.search(query, candidateIds);
          ranker = "lexical-fallback";
        }
      }

      const selected: string[] = [];
      const exact = query.trim();
      if (candidateIds.has(exact)) selected.push(exact);
      for (const id of ordered) {
        if (candidateIds.has(id) && !selected.includes(id)) selected.push(id);
      }

      const tools: JsonObject[] = [];
      let bytes = RESPONSE_ENVELOPE_BYTES;
      let truncated = false;
      for (const id of selected.slice(0, limit)) {
        const entry = byId.get(id) as CatalogEntry;
        if (bytes + entry.bytes + 1 > RESPONSE_BUDGET_BYTES) {
          truncated = true;
          break;
        }
        bytes += entry.bytes + 1;
        tools.push(entry.published);
      }
      report({
        requestId: context.requestId,
        ...(context.principal === null
          ? {}
          : { principalId: context.principal.id }),
        resultCount: tools.length,
        truncated,
        ranker,
      });
      return { tools, truncated };
    },
  }) as unknown as AnyCapability;

  const invoker = (readOnlyOnly: boolean): AnyCapability =>
    Object.freeze({
      title: readOnlyOnly ? "Invoke a read-only tool" : "Invoke a tool",
      description: readOnlyOnly
        ? `Call one read-only tool found with ${ids.search}. Pass its ID as tool and its input as arguments. Tools that change data must use ${ids.invoke}.`
        : `Call any tool found with ${ids.search}, including tools that change or delete data. Pass its ID as tool and its input as arguments.`,
      input: invokeInput,
      output: invokeOutput,
      access: "public",
      annotations: Object.freeze(
        readOnlyOnly
          ? { readOnly: true }
          : { destructive: true, openWorld: true },
      ),
      errors: Object.freeze({
        TOOL_NOT_FOUND: NOT_FOUND,
        ...(readOnlyOnly ? { TOOL_NOT_READ_ONLY: NOT_READ_ONLY } : {}),
        TOOL_DOMAIN_ERROR: TARGET_DOMAIN_ERROR,
      }),
      async run({
        input,
        context,
      }: {
        input: JsonObject;
        context: ExecutionContext;
      }) {
        const tool = input.tool as string;
        const entry = byId.get(tool);
        // A hidden tool is indistinguishable from a nonexistent one.
        if (entry === undefined || !visibleFor(context)(tool)) {
          throw new CapabilityError("TOOL_NOT_FOUND", { details: { tool } });
        }
        if (readOnlyOnly && !entry.readOnly) {
          throw new CapabilityError("TOOL_NOT_READ_ONLY", {
            details: { tool },
          });
        }
        try {
          const result = await inner.invoke(
            tool,
            (input.arguments ?? {}) as never,
            {
              requestId: context.requestId,
              source: context.source,
              principal: context.principal,
              signal: context.signal,
              onProgress: context.reportProgress,
            },
          );
          return { result };
        } catch (error) {
          if (
            !(error instanceof EngineError) ||
            error.code !== "DOMAIN_ERROR"
          ) {
            throw error;
          }
          const domain = error.publicDetails as DomainErrorPublicDetails;
          throw new CapabilityError("TOOL_DOMAIN_ERROR", {
            details: {
              tool,
              code: domain.code,
              retryable: domain.retryable,
              ...(domain.details === undefined
                ? {}
                : { details: domain.details }),
            },
            cause: error,
          });
        }
      },
    }) as unknown as AnyCapability;

  const capabilities: Record<string, AnyCapability> = {};
  const define = (id: string, capability: AnyCapability): void => {
    Object.defineProperty(capabilities, id, {
      enumerable: true,
      value: capability,
    });
  };
  define(ids.search, searchTools);
  define(ids.invokeRead, invoker(true));
  define(ids.invoke, invoker(false));

  const alwaysIds = selectAlwaysList(
    catalog.map((entry) => entry.id),
    options.alwaysList,
  );
  if (alwaysIds.length > 0) {
    const listed = upstreamCapabilities(
      engineUpstream({
        name: "always-list",
        engine: inner,
        include: alwaysIds,
      }),
    );
    for (const { route, ...contract } of listed) {
      if (discoveryIds.has(route.capabilityId)) {
        throw new TypeError(
          `Discovery alwaysList capability ${route.capabilityId} collides with a discovery tool.`,
        );
      }
      // The gateway rule runs inside the forwarded invocation.
      define(
        route.capabilityId,
        Object.freeze({
          ...contract,
          access: "public",
        }) as unknown as AnyCapability,
      );
    }
  }
  const alwaysSet = new Set(alwaysIds);

  const visibility: GatewayVisibility = ({ principal, capabilityId }) => {
    if (discoveryIds.has(capabilityId)) return true;
    if (!alwaysSet.has(capabilityId)) return false;
    return gateway.visibility({ principal, capabilityId });
  };

  return Object.freeze({
    capabilities: Object.freeze(capabilities),
    visibility,
    gatewayEngine: inner,
  });
}

function selectAlwaysList(
  ids: ReadonlyArray<string>,
  patterns: unknown,
): ReadonlyArray<string> {
  if (patterns === undefined) return [];
  const compiled = compilePatterns(patterns, "Discovery alwaysList pattern");
  for (const { pattern, matches } of compiled) {
    if (!ids.some(matches)) {
      throw new TypeError(
        `Discovery alwaysList pattern ${pattern} matches no capability.`,
      );
    }
  }
  const selected = ids.filter((id) =>
    compiled.some(({ matches }) => matches(id)),
  );
  if (selected.length > MAX_ALWAYS_LIST) {
    throw new TypeError(
      `Discovery alwaysList selects ${String(selected.length)} capabilities; at most ${String(MAX_ALWAYS_LIST)} are allowed.`,
    );
  }
  return selected;
}

/** Runs `operation` until it settles, the caller aborts, or the deadline passes. */
async function withDeadline<Value>(
  operation: (signal: AbortSignal) => Promise<Value>,
  callerSignal: AbortSignal,
  timeoutMs: number,
): Promise<Value> {
  const deadline = new AbortController();
  const signal = AbortSignal.any([callerSignal, deadline.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = (): void => undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error("The ranker did not finish."));
    timer = setTimeout(() => deadline.abort(), timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([operation(signal), expired]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

function freezeClone(principal: Principal | null): Principal | null {
  if (principal === null) return null;
  const clone = structuredClone(principal);
  const freeze = (value: unknown): void => {
    if (
      typeof value === "object" &&
      value !== null &&
      !Object.isFrozen(value)
    ) {
      for (const nested of Object.values(value)) freeze(nested);
      Object.freeze(value);
    }
  };
  freeze(clone);
  return clone;
}
