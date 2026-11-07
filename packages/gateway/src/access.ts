import type { GatewayAccessFunction } from "./types.js";

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
  return ({ principal }) => {
    const granted = principal?.attributes?.scopes;
    return (
      Array.isArray(granted) &&
      required.every((scope) => granted.includes(scope))
    );
  };
}
