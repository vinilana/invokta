# ADR 0054: Search-based tool discovery for gateways

- Status: Accepted
- Date: 2026-11-09

## Context

A gateway (ADR 0053) can publish hundreds of tools. Measured with a 200-tool
fixture, one `tools/list` is about 97 KB, roughly 24,000 tokens, before any
real description or schema; every conversation of every client pays it, and
models choose tools worse among hundreds. Per-caller visibility (ADR 0052)
removes what a caller cannot use, but a caller allowed to use 180 tools still
receives 180. Some clients search large MCP catalogs on their own; the gateway
cannot rely on every client doing so.

## Decision

`@invokta/gateway` exports `createDiscovery(options)`, which returns a frozen
`{ capabilities, visibility, gatewayEngine }`. The host serves `capabilities`
as its own engine, normally at a mount path such as `/search/mcp`, with
`visibility` as the adapter option, and may serve `gatewayEngine`, the full
catalog, to clients that search on their own.

### Three tools

| Capability | Annotations | Contract |
| --- | --- | --- |
| `<prefix>.search-tools` | `readOnly` | `{ query, limit? }`: 1 to 256 characters and 1 to 20 results, 8 by default. Returns `{ tools, truncated }`, each tool with its ID, title, description, schemas, annotations, and deprecation |
| `<prefix>.invoke-read-tool` | `readOnly` | `{ tool, arguments? }`; accepts only targets whose route is trusted read-only (ADR 0053) |
| `<prefix>.invoke-tool` | `destructive`, `openWorld` | `{ tool, arguments? }`; accepts every visible target |

The prefix defaults to `gateway`. Splitting invocation by risk class keeps a
client's confirmation meaningful: it can allow `invoke-read-tool` without
prompting and still confirm every `invoke-tool` call. A read sent to
`invoke-tool` costs a confirmation, never a bypass.

The discovery tools have no authority of their own: their access is `public`,
they are visible to every caller, and every decision is delegated to
`gateway.visibility` and to the target's gateway rule.

### One execution path

`createDiscovery` builds the gateway engine itself from `gateway.capabilities`
and accepts only its name, version, logger, event hook, and capability
middleware, which `applyMiddleware` composes around every gateway capability so
it runs for discovered and direct calls alike. An `invoke-*` call
forwards to that engine's `invoke` with the caller's principal, signal,
request ID, source, and progress sink, so the target's gateway rule, input
validation, upstream access, timeout, events, and audit decision apply exactly
as for a direct call. Accepting a host engine would let an engine built from
the upstreams, rather than the gateway, bypass every gateway rule.

### Errors

| Situation | Result |
| --- | --- |
| Unknown or hidden target | Declared domain error `TOOL_NOT_FOUND`, identical in both cases |
| Untrusted read-only status on `invoke-read-tool` | Declared domain error `TOOL_NOT_READ_ONLY` |
| Target fails with a framework code | The same code |
| Target raises a declared domain error | `TOOL_DOMAIN_ERROR` with `{ tool, code, retryable, details? }`, because ADR 0045 allows at most 64 declarations per capability |

### Ranking

The default ranking is deterministic BM25 over each tool's ID segments
(weight 3), title (2), and description (1), built once from the frozen
catalog. A query equal to a visible capability ID returns it first. Tokens are
split on camelCase and every non-letter, non-digit character, lowercased,
folded to remove diacritics, and folded from regular plurals (`-s`, `-es`,
`-ies`) to the singular, the same way for the catalog and the query; there is
no other stemming, no synonym list, and no translation. `createSearchIndex` and
`tokenize` are exported for host rankers.

A host MAY inject `rank(query, candidates, { signal })`, for example
embeddings or a decision model. It receives only the caller's visible tools;
its result is deduplicated and intersected with them, so it can reorder or
drop tools but never reveal one. A ranker that fails, returns non-string IDs,
or misses its deadline (2,000 ms by default, at most 60,000) falls back to the
lexical ranking; caller cancellation still cancels the search.
`queryGuidance` replaces the default "a few keywords" instruction for rankers
that understand whole tasks, and `queryLanguage` names the catalog's
language. Invokta provides no embedding or retrieval abstraction
(AE-LIMIT-03); a ranker and its service are host-owned.

### Bounds and audit

Results stay within a 64 KiB response budget: entries that would exceed it
are dropped from the tail, `truncated` is `true`, and a schema is returned
whole or not at all. `alwaysList` publishes at most 32 capabilities directly,
next to the three tools, chosen by configuration only; every pattern must
match and each entry stays subject to the caller's visibility. `onSearch`
receives the request ID, principal ID, result count, `truncated`, and the
ranker used, never the query text.

## Consequences

- A client sees a constant, small catalog whatever the gateway publishes, and
  discovers the rest on demand without losing per-tool authorization.
- `invoke-tool` is a generic execution entry point, the kind of
  infrastructure interface AE-INV-01 rejects as a domain action. It is
  accepted only as gateway infrastructure: an Action Engine never publishes
  it, and every target remains a domain capability addressable by its own ID.
- Three tools stand for many capabilities at the protocol surface, departing
  from "one capability, one tool" (AE-MCP-01) for the discovery engine only;
  inside the gateway engine each target is still one capability and one tool.
- The `invoke-*` output is `{ result }` with a generic schema, so typed
  `structuredContent` and rich content blocks of the target are not
  reproduced.
- A rate limit or quota per target is a capability middleware passed to
  `gatewayEngine.middleware`, not a gateway feature (AE-LIMIT-01).
