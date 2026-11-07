import type {
  AccessRule,
  AnyCapability,
  CapabilityMap,
  ExecutionContext,
  Principal,
} from "@invokta/core";

import type { JsonObject } from "./json-schema-contract.js";
import { compilePatterns, type Matcher } from "./patterns.js";
import type {
  GatewayAccess,
  GatewayDecision,
  GatewayOptions,
  GatewayRoute,
  GatewayUpstreamCapability,
  GatewayUpstreamRoute,
} from "./types.js";
import { upstreamCapabilities } from "./upstream-registry.js";

export interface Gateway {
  /**
   * A plain capability map. Pass it to `createEngine`, optionally through
   * `applyMiddleware` or next to engine-local capabilities, and serve that
   * engine with any adapter.
   */
  readonly capabilities: CapabilityMap;
  /** Every published capability, its upstream, and the rule governing it. */
  readonly routes: ReadonlyArray<GatewayRoute>;
}

interface CompiledRule {
  readonly name: string;
  readonly patterns: ReadonlyArray<{
    readonly pattern: string;
    readonly matches: Matcher;
  }>;
  readonly access: GatewayAccess;
}

/**
 * Builds the capability map of a gateway over explicitly configured
 * upstreams.
 *
 * Authentication stays at the adapter boundary: the HTTP and MCP HTTP
 * adapters run their `authenticate` hook before `engine.invoke`. The gateway
 * adds authorization: every capability gets the access rule of the first
 * matching gateway rule, or `defaultAccess`, which denies by default. The
 * upstream still enforces its own access rule after the gateway allows.
 */
export function createGateway(options: GatewayOptions): Gateway {
  if (!Array.isArray(options.upstreams) || options.upstreams.length === 0) {
    throw new TypeError("A gateway must configure at least one upstream.");
  }
  const onDecision = options.onDecision;
  if (onDecision !== undefined && typeof onDecision !== "function") {
    throw new TypeError("Gateway onDecision must be a function.");
  }
  const rules = compileRules(options.rules ?? []);
  const defaultAccess = assertAccess(
    options.defaultAccess ?? "deny",
    "Gateway defaultAccess",
  );

  const entries: GatewayUpstreamCapability[] = [];
  const owners = new Map<string, string>();
  const names = new Set<string>();
  for (const upstream of options.upstreams) {
    const capabilities = upstreamCapabilities(upstream);
    if (names.has(upstream.name)) {
      throw new TypeError(
        `Gateway upstream ${upstream.name} is configured twice.`,
      );
    }
    names.add(upstream.name);
    for (const capability of capabilities) {
      const { capabilityId } = capability.route;
      const owner = owners.get(capabilityId);
      if (owner !== undefined) {
        throw new TypeError(
          `Gateway capability ${capabilityId} is published by both ${owner} and ${upstream.name}.`,
        );
      }
      owners.set(capabilityId, upstream.name);
      entries.push(capability);
    }
  }

  const usedRules = new Set<CompiledRule>();
  const capabilities: Record<string, AnyCapability> = {};
  const routes: GatewayRoute[] = [];
  for (const entry of entries) {
    const { capabilityId } = entry.route;
    const rule = rules.find(({ patterns }) =>
      patterns.some(({ matches }) => matches(capabilityId)),
    );
    if (rule !== undefined) usedRules.add(rule);
    const ruleName = rule?.name ?? "default";
    const { route, ...contract } = entry;
    // A data property, so an ID such as `__proto__` cannot reach the prototype.
    Object.defineProperty(capabilities, capabilityId, {
      enumerable: true,
      value: Object.freeze({
        ...contract,
        access: toAccessRule(
          rule?.access ?? defaultAccess,
          route,
          ruleName,
          onDecision,
        ),
      }) as unknown as AnyCapability,
    });
    routes.push(Object.freeze({ ...route, rule: ruleName }));
  }
  for (const rule of rules) {
    if (usedRules.has(rule)) continue;
    const reachable = entries.some(({ route }) =>
      rule.patterns.some(({ matches }) => matches(route.capabilityId)),
    );
    throw new TypeError(
      reachable
        ? `Gateway rule ${rule.name} is shadowed by earlier rules.`
        : `Gateway rule ${rule.name} matches no capability.`,
    );
  }

  return Object.freeze({
    capabilities: Object.freeze(capabilities),
    routes: Object.freeze(routes),
  });
}

function compileRules(
  rules: GatewayOptions["rules"],
): ReadonlyArray<CompiledRule> {
  if (!Array.isArray(rules)) {
    throw new TypeError("Gateway rules must be an array.");
  }
  const names = new Set<string>();
  return rules.map((rule, index) => {
    const name = rule.name ?? `rules[${String(index)}]`;
    if (typeof name !== "string" || name === "" || names.has(name)) {
      throw new TypeError(`Gateway rule ${name} must have a unique name.`);
    }
    names.add(name);
    return Object.freeze({
      name,
      patterns: compilePatterns(rule.match, `Gateway rule ${name} match`),
      access: assertAccess(rule.access, `Gateway rule ${name} access`),
    });
  });
}

function assertAccess(access: unknown, label: string): GatewayAccess {
  if (
    access === "public" ||
    access === "authenticated" ||
    access === "deny" ||
    typeof access === "function"
  ) {
    return access as GatewayAccess;
  }
  throw new TypeError(
    `${label} must be public, authenticated, deny, or a function.`,
  );
}

/**
 * Converts a gateway access value into a core access function. Every decision
 * is reported, and a throwing or rejecting function is a denial rather than an
 * execution failure, so an unavailable policy dependency fails closed.
 */
function toAccessRule(
  access: GatewayAccess,
  route: GatewayUpstreamRoute,
  rule: string,
  onDecision: GatewayOptions["onDecision"],
): AccessRule<JsonObject> {
  return async ({ principal, input, context }) => {
    let outcome: GatewayDecision["outcome"];
    try {
      outcome = (await decide(access, principal, input, context, route))
        ? "allowed"
        : "denied";
    } catch {
      outcome = "failed";
      context.logger.warn("Gateway access rule failed; access was denied.", {
        requestId: context.requestId,
        capabilityId: route.capabilityId,
        rule,
      });
    }
    report(onDecision, {
      requestId: context.requestId,
      capabilityId: route.capabilityId,
      upstream: route.upstream,
      rule,
      outcome,
      ...(principal === null ? {} : { principalId: principal.id }),
    });
    return outcome === "allowed";
  };
}

async function decide(
  access: GatewayAccess,
  principal: Principal | null,
  input: JsonObject,
  context: ExecutionContext,
  route: GatewayUpstreamRoute,
): Promise<boolean> {
  switch (access) {
    case "public":
      return true;
    case "authenticated":
      return principal !== null;
    case "deny":
      return false;
    default:
      return (await access({ principal, input, context, route })) === true;
  }
}

function report(
  onDecision: GatewayOptions["onDecision"],
  decision: GatewayDecision,
): void {
  if (onDecision === undefined) return;
  try {
    const pending = onDecision(Object.freeze(decision));
    if (pending instanceof Promise) pending.catch(() => undefined);
  } catch {
    // An audit sink cannot change an authorization decision.
  }
}
