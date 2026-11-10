import type { ApiKeyCredential } from "@invokta/gateway";

const MAX_CONFIGURED_KEYS = 100;

/**
 * Parses `GATEWAY_API_KEYS`: a JSON array of `{ "id", "sha256", "scopes"? }`.
 * Only digests are configured; the scopes become `principal.attributes.scopes`.
 */
export function parseApiKeys(json: string): ReadonlyArray<ApiKeyCredential> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new TypeError("GATEWAY_API_KEYS must be a JSON array.");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.length > MAX_CONFIGURED_KEYS
  ) {
    throw new TypeError(
      `GATEWAY_API_KEYS must list 1 to ${String(MAX_CONFIGURED_KEYS)} keys.`,
    );
  }
  return parsed.map((entry: unknown, index) => {
    const { id, sha256, scopes } = (entry ?? {}) as Record<string, unknown>;
    if (
      typeof id !== "string" ||
      typeof sha256 !== "string" ||
      (scopes !== undefined &&
        (!Array.isArray(scopes) ||
          scopes.some((scope) => typeof scope !== "string")))
    ) {
      throw new TypeError(
        `GATEWAY_API_KEYS[${String(index)}] needs string id, sha256, and scopes.`,
      );
    }
    return {
      id,
      sha256,
      attributes: { scopes: (scopes as string[] | undefined) ?? [] },
    };
  });
}
