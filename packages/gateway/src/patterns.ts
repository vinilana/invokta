const NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;

/** Validates an upstream name or namespace: lowercase ASCII, digits, and inner hyphens. */
export function assertName(value: unknown, label: string): string {
  if (typeof value !== "string" || !NAME.test(value)) {
    throw new TypeError(
      `${label} must be 1-64 lowercase letters, digits, or inner hyphens.`,
    );
  }
  return value;
}

export type Matcher = (id: string) => boolean;

/**
 * Compiles one ID pattern: `*`, an exact ID, or `prefix.*`. Wildcards are
 * accepted only as the whole pattern or as the final `.*` segment so a pattern
 * always reads as an explicit namespace boundary.
 */
export function compilePattern(pattern: unknown, label: string): Matcher {
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  if (pattern === "*") return () => true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -1);
    if (prefix.length <= 1 || prefix.slice(0, -1).includes("*")) {
      throw new TypeError(`${label} ${pattern} is not a valid pattern.`);
    }
    return (id) => id.startsWith(prefix) && id.length > prefix.length;
  }
  if (pattern.includes("*")) {
    throw new TypeError(`${label} ${pattern} is not a valid pattern.`);
  }
  return (id) => id === pattern;
}

export function compilePatterns(
  patterns: unknown,
  label: string,
): ReadonlyArray<{ readonly pattern: string; readonly matches: Matcher }> {
  const list = typeof patterns === "string" ? [patterns] : patterns;
  if (!Array.isArray(list) || list.length === 0) {
    throw new TypeError(`${label} must list at least one pattern.`);
  }
  return list.map((pattern: unknown) => ({
    pattern: pattern as string,
    matches: compilePattern(pattern, label),
  }));
}

/**
 * Applies an include list to upstream IDs. Every pattern must select at least
 * one ID so a typo cannot silently narrow or widen the published catalog.
 */
export function selectIncluded(
  ids: ReadonlyArray<string>,
  include: unknown,
  upstream: string,
): ReadonlyArray<string> {
  if (include === undefined) return ids;
  const patterns = compilePatterns(
    include,
    `Upstream ${upstream} include pattern`,
  );
  for (const { pattern, matches } of patterns) {
    if (!ids.some(matches)) {
      throw new TypeError(
        `Upstream ${upstream} include pattern ${pattern} matches no capability.`,
      );
    }
  }
  return ids.filter((id) => patterns.some(({ matches }) => matches(id)));
}
