import type { Principal } from "@invokta/core";
import type { GatewayRule, GatewayUpstreamRoute } from "@invokta/gateway";

function hasScope(principal: Principal | null, scope: string): boolean {
  const scopes = principal?.attributes?.scopes;
  return Array.isArray(scopes) && scopes.includes(scope);
}

/** Deleting CRM records is reserved for the vendor's own console. */
function isDeletion(route: GatewayUpstreamRoute): boolean {
  return /_delete-/u.test(route.upstreamCapabilityId);
}

/**
 * Whether a caller may use one CRM tool. It reads only the principal and the
 * route, never input, so the same function is both the access rule and the
 * visibility: a caller lists exactly the tools it can call.
 */
export function canUseCrmTool(
  principal: Principal | null,
  route: GatewayUpstreamRoute,
): boolean {
  if (isDeletion(route)) return false;
  return hasScope(principal, route.readOnly ? "crm:read" : "crm:write");
}

export const crmRules: ReadonlyArray<GatewayRule> = Object.freeze([
  {
    name: "crm",
    match: "crm.*",
    access: ({ principal, route }) => canUseCrmTool(principal, route),
    visible: canUseCrmTool,
  },
]);
