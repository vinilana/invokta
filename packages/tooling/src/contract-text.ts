/** Longest file- or engine-controlled identifier echoed by a diagnostic. */
export const maximumEchoedLength = 64;

const formatCharacter = /\p{Cf}/u;

/**
 * C0 and C1 controls, DEL, line and paragraph separators, and format
 * characters such as bidirectional overrides. `JSON.stringify` escapes only
 * U+0000-U+001F, so the rest would otherwise reach a terminal raw.
 */
function isUnsafe(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    formatCharacter.test(character)
  );
}

function escapeUnit(character: string): string {
  let escaped = "";
  for (let index = 0; index < character.length; index += 1) {
    escaped += `\\u${character.charCodeAt(index).toString(16).padStart(4, "0")}`;
  }
  return escaped;
}

/** Truncates by code point so a surrogate pair is never split. */
function truncate(value: string, maximumLength: number): string {
  if (value.length <= maximumLength) return value;
  // Twice as many code units always hold at least `maximumLength` code points.
  const head = Array.from(value.slice(0, maximumLength * 2));
  if (head.length <= maximumLength && value.length <= maximumLength * 2) {
    return value;
  }
  return `${head.slice(0, maximumLength).join("")}…`;
}

/**
 * Escapes every control, separator, and format character so echoed text
 * cannot forge a line or steer a terminal. With `maximumLength`, longer text
 * is truncated first.
 */
export function escapeText(value: string, maximumLength?: number): string {
  const bounded =
    maximumLength === undefined ? value : truncate(value, maximumLength);
  let escaped = "";
  for (const character of bounded) {
    escaped += isUnsafe(character) ? escapeUnit(character) : character;
  }
  return escaped;
}

/** Encodes a value as an escaped JSON string literal; see `escapeText`. */
export function quoteText(value: string, maximumLength?: number): string {
  const bounded =
    maximumLength === undefined ? value : truncate(value, maximumLength);
  return escapeText(JSON.stringify(bounded));
}

/** Quotes a file- or engine-controlled identifier for a bounded diagnostic. */
export function quoteIdentifier(value: string): string {
  return quoteText(value, maximumEchoedLength);
}
