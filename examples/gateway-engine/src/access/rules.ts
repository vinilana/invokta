import { type GatewayRule, requireScopes } from "@invokta/gateway";

/**
 * Acme's gateway policy, evaluated in order: the first rule whose pattern
 * matches a capability governs it, and anything no rule matches is denied.
 *
 * Scopes come from `principal.attributes.scopes`, which both the API key
 * authenticator and the `@invokta/auth-jwt` default mapping fill.
 */
export const acmeRules: ReadonlyArray<GatewayRule> = Object.freeze([
  {
    name: "refunds",
    match: "billing.refund-invoice",
    access: requireScopes("billing:refund"),
  },
  {
    name: "billing-read",
    match: "billing.*",
    access: requireScopes("billing:read"),
  },
  {
    name: "support",
    match: "support.*",
    access: requireScopes("support"),
  },
  {
    name: "knowledge-base",
    match: "kb.*",
    access: "authenticated",
  },
]);
