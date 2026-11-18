import {
  createSearchIndex,
  type DiscoveryRanker,
  tokenize,
} from "@invokta/gateway";

/**
 * Portuguese terms an agent may search with, mapped to the vocabulary of the
 * vendor's English tool descriptions. This is the host-owned part of
 * search: replace it with embeddings or a larger glossary in production.
 */
const glossary: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ["criar", "create"],
  ["cadastrar", "create"],
  ["novo", "create"],
  ["atualizar", "update"],
  ["editar", "update"],
  ["alterar", "update"],
  ["excluir", "delete"],
  ["apagar", "delete"],
  ["remover", "delete"],
  ["obter", "get"],
  ["consultar", "get"],
  ["ver", "get"],
  ["listar", "list"],
  ["buscar", "search"],
  ["pesquisar", "search"],
  ["procurar", "search"],
  ["arquivar", "archive"],
  ["exportar", "export"],
  ["aprovar", "approve"],
  ["cancelar", "cancel"],
  ["fatura", "invoice"],
  ["assinatura", "subscription"],
  ["cliente", "customer"],
  ["conta", "account"],
  ["pedido", "order"],
  ["remessa", "shipment"],
  ["envio", "shipment"],
  ["chamado", "ticket"],
  ["produto", "product"],
  ["estoque", "stock"],
  ["pagamento", "payment"],
  ["contrato", "contract"],
  ["funcionário", "employee"],
  ["colaborador", "employee"],
  ["projeto", "project"],
  ["documento", "document"],
  ["arquivo", "document"],
  ["relatório", "report"],
  ["campanha", "campaign"],
  ["fornecedor", "vendor"],
  ["ativo", "asset"],
  ["reunião", "meeting"],
  ["reuniões", "meeting"],
]);

/** Glossary keys go through the same tokenizer as queries: folded and singular. */
const translations = new Map(
  glossary.map(([portuguese, english]) => [
    tokenize(portuguese)[0] as string,
    english,
  ]),
);

/** Rewrites each Portuguese token to its English term; other tokens stay. */
export function translateQuery(query: string): string {
  return tokenize(query)
    .map((token) => translations.get(token) ?? token)
    .join(" ");
}

/**
 * A `rank` port for `createDiscovery`: translate the query, then rank the
 * caller's visible candidates with the gateway's own BM25 index. The gateway
 * intersects the result with the visible candidates, so this ranker can
 * reorder or drop tools but never reveal one.
 */
export const portugueseGlossaryRanker: DiscoveryRanker = async (
  query,
  candidates,
) => {
  const index = createSearchIndex(candidates);
  return index.search(
    translateQuery(query),
    new Set(candidates.map((candidate) => candidate.id)),
  );
};
