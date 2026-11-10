import type { Principal } from "@invokta/core";

import type { GatewayAccessFunction } from "./types.js";

const principalOnly = new WeakMap<
  GatewayAccessFunction,
  (principal: Principal | null) => boolean
>();

/**
 * Returns the principal-only predicate of an access function built by this
 * module, which the gateway uses as its visibility, or `undefined`.
 */
export function principalPredicate(
  access: GatewayAccessFunction,
): ((principal: Principal | null) => boolean) | undefined {
  return principalOnly.get(access);
}

/**
 * An access function requiring every listed scope in
 * `principal.attributes.scopes`, the attribute the default principal mapping
 * of `@invokta/auth-jwt` fills from the `scope` claim.
 */
export function requireScopes(
  ...scopes: ReadonlyArray<string>
): GatewayAccessFunction {
  if (
    scopes.length === 0 ||
    scopes.some((scope) => typeof scope !== "string" || scope === "")
  ) {
    throw new TypeError("requireScopes needs at least one non-empty scope.");
  }
  const required = Object.freeze([...scopes]);
  const holdsScopes = (principal: Principal | null): boolean => {
    const granted = principal?.attributes?.scopes;
    return (
      Array.isArray(granted) &&
      required.every((scope) => granted.includes(scope))
    );
  };
  const access: GatewayAccessFunction = ({ principal }) =>
    holdsScopes(principal);
  // The decision reads only the principal, so it is also the visibility.
  principalOnly.set(access, holdsScopes);
  return access;
}
