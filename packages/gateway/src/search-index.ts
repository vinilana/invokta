/** One searchable capability. */
export interface SearchDocument {
  readonly id: string;
  readonly title?: string;
  readonly description: string;
}

export interface SearchIndex {
  /** Capability IDs from `candidates` that match the query, best first. */
  search(query: string, candidates: ReadonlySet<string>): string[];
}

/** ID segments and the title say more about a tool than its description. */
const ID_WEIGHT = 3;
const TITLE_WEIGHT = 2;
const DESCRIPTION_WEIGHT = 1;
const K1 = 1.2;
const B = 0.75;

/**
 * Splits text into search tokens: camelCase boundaries and every character
 * that is not a letter or digit separate tokens, which are lowercased, folded
 * to remove diacritics, and folded from a regular plural to its singular.
 * There is no other stemming, no synonym list, and no translation.
 */
export function tokenize(text: string): string[] {
  return text
    .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, "$1 $2")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token !== "")
    .map(singular);
}

/**
 * Folds a regular plural to its singular, the same way for the catalog and
 * the query: `tickets`, `addresses`, `matches`, and `categories` become
 * `ticket`, `address`, `match`, and `category`. Short tokens and `-ss` stay.
 */
function singular(token: string): string {
  if (token.length <= 3 || /\d$/u.test(token)) return token;
  if (token.endsWith("sses")) return token.slice(0, -2);
  if (token.endsWith("ies") && token.length > 4) {
    return `${token.slice(0, -3)}y`;
  }
  if (/(?:x|ch|sh)es$/u.test(token)) return token.slice(0, -2);
  if (token.endsWith("s") && !token.endsWith("ss") && !token.endsWith("us")) {
    return token.slice(0, -1);
  }
  return token;
}

/**
 * Builds a deterministic BM25 index over weighted fields. It is built once
 * from a frozen catalog and performs no I/O; equal scores are ordered by
 * capability ID so the same query always returns the same tools.
 */
export function createSearchIndex(
  documents: ReadonlyArray<SearchDocument>,
): SearchIndex {
  const entries = documents.map((document) => {
    const frequencies = new Map<string, number>();
    let length = 0;
    const add = (text: string, weight: number): void => {
      for (const token of tokenize(text)) {
        frequencies.set(token, (frequencies.get(token) ?? 0) + weight);
        length += weight;
      }
    };
    add(document.id, ID_WEIGHT);
    if (document.title !== undefined) add(document.title, TITLE_WEIGHT);
    add(document.description, DESCRIPTION_WEIGHT);
    return { id: document.id, frequencies, length };
  });
  const documentFrequency = new Map<string, number>();
  for (const entry of entries) {
    for (const token of entry.frequencies.keys()) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }
  const total = entries.length;
  const averageLength =
    entries.reduce((sum, entry) => sum + entry.length, 0) /
      Math.max(total, 1) || 1;

  return Object.freeze({
    search(query: string, candidates: ReadonlySet<string>): string[] {
      const terms = [...new Set(tokenize(query))];
      if (terms.length === 0) return [];
      const scored: Array<{ readonly id: string; readonly score: number }> = [];
      for (const entry of entries) {
        if (!candidates.has(entry.id)) continue;
        let score = 0;
        for (const term of terms) {
          const frequency = entry.frequencies.get(term);
          if (frequency === undefined) continue;
          const containing = documentFrequency.get(term) ?? 0;
          const idf = Math.log(
            1 + (total - containing + 0.5) / (containing + 0.5),
          );
          score +=
            (idf * (frequency * (K1 + 1))) /
            (frequency + K1 * (1 - B + (B * entry.length) / averageLength));
        }
        if (score > 0) scored.push({ id: entry.id, score });
      }
      scored.sort(
        (left, right) =>
          right.score - left.score ||
          (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
      );
      return scored.map(({ id }) => id);
    },
  });
}
