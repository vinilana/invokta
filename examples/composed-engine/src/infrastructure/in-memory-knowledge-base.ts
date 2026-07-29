import type {
  KnowledgeArticle,
  KnowledgeBase,
} from "@invokta/example-community-capabilities";

const minimumTermLength = 4;

export function createInMemoryKnowledgeBase(
  articles: ReadonlyArray<KnowledgeArticle>,
): KnowledgeBase {
  return {
    async search(query, { signal }) {
      signal.throwIfAborted();
      const terms = query
        .toLowerCase()
        .split(/\s+/u)
        .filter((term) => term.length >= minimumTermLength);
      return articles.filter((article) => {
        const title = article.title.toLowerCase();
        return terms.some((term) => title.includes(term));
      });
    },
  };
}
