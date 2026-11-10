import type {
  CapabilityAnnotations,
  CapabilityDeprecation,
  CapabilityErrorMap,
  EngineSchema,
  ExecutionContext,
  Principal,
} from "@invokta/core";

import type { JsonObject } from "./json-schema-contract.js";

/** Where a gateway capability is executed. */
export type GatewayUpstreamKind = "engine" | "mcp";

/** One published gateway capability and the upstream operation behind it. */
export interface GatewayUpstreamRoute {
  /** The capability ID the gateway publishes. */
  readonly capabilityId: string;
  /** The configured upstream name. */
  readonly upstream: string;
  readonly kind: GatewayUpstreamKind;
  /** The upstream capability ID, or the MCP tool name. */
  readonly upstreamCapabilityId: string;
  /**
   * Whether the operation is trusted to be read-only: an engine upstream's
   * `readOnly` annotation, or an MCP tool the operator vouched for with
   * `trustAnnotations` or `readOnlyTools`. An MCP server's own hint alone
   * never makes this `true`.
   */
  readonly readOnly: boolean;
}

/** A gateway route together with the name of the rule that governs it. */
export interface GatewayRoute extends GatewayUpstreamRoute {
  /** The rule `name`, `rules[<index>]` when unnamed, or `default`. */
  readonly rule: string;
}

/**
 * A configured upstream. Create one with `engineUpstream` or `mcpUpstream`;
 * the gateway only accepts values produced by those functions.
 */
export interface GatewayUpstream {
  readonly name: string;
  readonly kind: GatewayUpstreamKind;
  readonly routes: ReadonlyArray<GatewayUpstreamRoute>;
}

/** Arguments of a gateway access function. */
export interface GatewayAccessArgs {
  readonly principal: Principal | null;
  /**
   * The input after the gateway's validation: the configured JSON Schema
   * validator's, or only the structural check when validation is delegated
   * to the upstream.
   */
  readonly input: JsonObject;
  readonly context: ExecutionContext;
  readonly route: GatewayUpstreamRoute;
}

export type GatewayAccessFunction = (
  args: GatewayAccessArgs,
) => boolean | Promise<boolean>;

/**
 * The access a rule grants. `public` and `authenticated` keep their core
 * meaning, `deny` refuses every caller, and a function allows only when it
 * returns exactly `true`.
 */
export type GatewayAccess =
  | "public"
  | "authenticated"
  | "deny"
  | GatewayAccessFunction;

export interface GatewayRule {
  /** A stable name reported in routes and decisions. */
  readonly name?: string;
  /**
   * Gateway capability IDs this rule governs: an exact ID, a `prefix.*`
   * pattern matching IDs that start with `prefix.`, or `*` for every ID.
   */
  readonly match: string | ReadonlyArray<string>;
  readonly access: GatewayAccess;
  /**
   * Who sees the governed capabilities in listings and search. Defaults to
   * the access itself for `public`, `authenticated`, `deny`, and
   * `requireScopes`, and to every authenticated caller for other functions,
   * which may depend on input a listing does not have. It receives the
   * capability's route, so one rule can show reads and writes to different
   * callers. It must be synchronous. Visibility never grants access.
   */
  readonly visible?: (
    principal: Principal | null,
    route: GatewayUpstreamRoute,
  ) => boolean;
}

/**
 * The visibility option of `@invokta/mcp` and `@invokta/http`: whether one
 * capability is listed for, and callable by, the authenticated principal.
 */
export type GatewayVisibility = (args: {
  readonly principal: Principal | null;
  readonly capabilityId: string;
}) => boolean;

/** One authorization decision, free of input, output, and credentials. */
export interface GatewayDecision {
  readonly requestId: string;
  readonly capabilityId: string;
  readonly upstream: string;
  readonly rule: string;
  /** `failed` means the access function threw and access was denied. */
  readonly outcome: "allowed" | "denied" | "failed";
  readonly principalId?: string;
}

export interface GatewayOptions {
  readonly upstreams: ReadonlyArray<GatewayUpstream>;
  /** Evaluated in order; the first rule matching a capability governs it. */
  readonly rules?: ReadonlyArray<GatewayRule>;
  /** Access for capabilities no rule matches. Defaults to `deny`. */
  readonly defaultAccess?: GatewayAccess;
  /** Receives every decision. Failures and returned promises are ignored. */
  readonly onDecision?: (decision: GatewayDecision) => void | Promise<void>;
}

/**
 * The upstream half of a gateway capability: everything except the access
 * rule, which the gateway attaches from its policy.
 */
export interface GatewayUpstreamCapability {
  readonly route: GatewayUpstreamRoute;
  readonly title?: string;
  readonly description: string;
  readonly input: EngineSchema<JsonObject>;
  readonly output: EngineSchema<JsonObject>;
  readonly timeoutMs?: number;
  readonly annotations?: CapabilityAnnotations;
  readonly deprecated?: CapabilityDeprecation;
  readonly errors?: CapabilityErrorMap;
  readonly run: (args: {
    readonly input: JsonObject;
    readonly context: ExecutionContext;
  }) => Promise<JsonObject>;
}
