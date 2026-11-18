# gateway-semantic-search-engine

Rank a vendor's 200 MCP tools with embeddings, so an agent can find the right
tool from a sentence in any language, behind a gateway that only ever shows
each caller the tools it may call.

> The API is in the
> [`@invokta/gateway` reference](https://docs.invokta.dev/reference/gateway/).

## How it works

```text
startup:  every published tool ──embed once──> normalized vectors in memory
search:   "cancelar o pedido O-42" ──embed──> query vector
          cosine similarity against the caller's visible tools only
          tools at or above minSimilarity, most similar first
```

- **Prepared at the composition root.** The gateway's catalog is frozen at
  startup, so the 200 tools are embedded once, in batches, before the
  gateway listens. A catalog that cannot be embedded fails startup. Each
  search then embeds only its query.
- **Across languages.** A multilingual embedding model matches a Portuguese
  sentence to an English tool description. The lexical search of
  `gateway-discovery-engine` scores 0.0 on the same kind of queries without
  its hand-written glossary.
- **Only visible tools are ranked.** The gateway passes the ranker the
  caller's visible tools and drops any other ID, so a ranker can reorder or
  drop tools but never reveal one.
- **A floor, not a forced answer.** Tools below `minSimilarity` (0.3 by
  default) are dropped; an unrelated question returns no tools.
- **Fail soft, never open.** If the embeddings service fails or misses its
  5-second deadline during a search, the gateway answers with its
  deterministic lexical search.

## The connector

[`infrastructure/openai-compatible-embedder.ts`](./src/infrastructure/openai-compatible-embedder.ts)
implements the engine-owned `TextEmbedder` port with `fetch` against the
OpenAI-compatible route:

```json
POST {EMBEDDINGS_BASE_URL}/embeddings
Authorization: Bearer $EMBEDDINGS_API_KEY   (omitted when no key is set)

{ "model": "text-embedding-3-small", "input": ["…", "…"], "encoding_format": "float" }
```

It validates one finite vector per input, all the same size and matched by
`index`, and bounds batches (64 texts), the per-request deadline (15 s), the
text length (8,000 characters), and the response size (16 MiB). Failures
carry at most the HTTP status, never the key or the response body.

| Service | `EMBEDDINGS_BASE_URL` | `EMBEDDINGS_MODEL` | Key |
| --- | --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` (default) | `text-embedding-3-small` (default) | `EMBEDDINGS_API_KEY` |
| Ollama, on this machine | `http://127.0.0.1:11434/v1` | a pulled embedding model, for example a multilingual one | none |
| vLLM or LM Studio | the server's `/v1` URL | the served model | as configured |

**What was verified.** The tests drive the connector, the index, and both
gateway endpoints with a deterministic concept embedder in which English and
Portuguese words for the same idea share a dimension; ten Portuguese
sentences find their tool first. That shows the mechanics, not a real model's
quality. No hosted embeddings service was called while building this
example; run it with your provider to measure your own queries.

**Data sent to the embeddings service.** At startup, the ID, title, and
description of every published tool; for each search, the query text.
Never credentials, tool input, or tool output. A local server such as Ollama
keeps both on your machine.

## Layout

```text
src/
  application/ports.ts                        # TextEmbedder port
  infrastructure/openai-compatible-embedder.ts # /embeddings connector (fetch)
  search/semantic-tool-index.ts               # prepared vectors, cosine rank port
  upstreams/crm-engine.ts                     # the vendor's 200 tools
  crm-mcp-http.ts                             # the vendor's MCP server
  access/                                     # route-aware rules, API keys
  gateway.ts                                  # discovery with the semantic ranker
  gateway-http.ts                             # /mcp and /search/mcp servers
test/
  openai-compatible-embedder.test.ts          # request shape, batching, validation
  semantic-search.test.ts                     # startup indexing, recall, visibility, fallback
  gateway-http.test.ts                        # an MCP client end to end
  support/concept-embedder.ts                 # the offline stand-in
```

## Environment

| Variable | Used by | Meaning |
| --- | --- | --- |
| `EMBEDDINGS_BASE_URL` | gateway | OpenAI-compatible API root; defaults to `https://api.openai.com/v1` |
| `EMBEDDINGS_MODEL` | gateway | Defaults to `text-embedding-3-small` |
| `EMBEDDINGS_API_KEY` | gateway | Optional Bearer key |
| `EMBEDDINGS_DIMENSIONS` | gateway | Optional vector size, for models that accept `dimensions` |
| `SEMANTIC_MIN_SIMILARITY` | gateway | Cosine floor; defaults to `0.3` |
| `CRM_SERVICE_TOKEN` | vendor server, gateway | Token the vendor server accepts; at least 16 characters |
| `CRM_MCP_URL` | gateway | Defaults to `http://127.0.0.1:3401/mcp` |
| `CRM_CATALOG_PIN` | gateway | Optional catalog fingerprint |
| `GATEWAY_API_KEYS` | gateway | JSON array of `{ "id", "sha256", "scopes"? }` with `crm:read` or `crm:write` |

## Run it

From the repository root, build once:

```sh
yarn build
cd examples/gateway-semantic-search-engine
```

Start the vendor's server in one terminal:

```sh
export CRM_SERVICE_TOKEN="$(openssl rand -hex 24)"
npm run upstream:crm
```

In a second terminal, with the same `CRM_SERVICE_TOKEN`, start the gateway
with your embeddings service:

```sh
export OPS_KEY="$(openssl rand -hex 24)"
export GATEWAY_API_KEYS="[{\"id\":\"sales-ops\",\"sha256\":\"$(printf '%s' "$OPS_KEY" | sha256sum | cut -d' ' -f1)\",\"scopes\":[\"crm:read\",\"crm:write\"]}]"
export EMBEDDINGS_API_KEY="..."
npm run gateway
```

Search in Portuguese from a third terminal:

```sh
curl -s -X POST http://127.0.0.1:3602/search/mcp \
  -H "x-api-key: $OPS_KEY" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"gateway_search-tools","arguments":{"query":"cancelar o pedido O-42","limit":3}}}'
```

The full catalog is at `http://127.0.0.1:3600/mcp`; send the key in the
`x-api-key` header.

## Combine with Jev

Semantic search is cheap per query and finds candidates; a decision model
such as TypeSafe's Jev, in
[`gateway-jev-engine`](../gateway-jev-engine/), decides which of them a task
needs. For large catalogs, a ranker can shortlist with embeddings and let Jev
judge only the shortlist.

## Test

```sh
yarn vitest run examples/gateway-semantic-search-engine
```

The tests start the vendor server, a loopback OpenAI-compatible embeddings
stand-in, and both gateway endpoints; nothing leaves the machine.
