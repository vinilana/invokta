# gateway-discovery-engine

Serve a vendor's 200-tool MCP server through a gateway that shows each caller
only the tools it can call, and lets clients that should not receive hundreds
of tools search for them instead.

> Proof of concept. `@invokta/gateway` is private and unpublished, so this
> example runs only inside this repository. The design is in
> [Action Engine gateway](../../docs/action-engine-gateway.md), sections D
> and C of "Tool discovery at scale".

## The scenario

A CRM vendor publishes one MCP tool per operation and record type: 20 record
types times `create`, `update`, `delete`, `get`, `list`, `search`,
`archive`, `export`, `approve`, and `cancel`. Acme's sales readers may only
read, sales operations may also write, and nobody may delete through the
gateway.

Measured with this example:

| What one `tools/list` returns | Tools | Size |
| --- | --- | --- |
| The vendor's full catalog for a sales-operations caller | 180 | about 117 KB, roughly 30,000 tokens |
| The same caller on `/search/mcp` | 5 | about 3.6 KB, roughly 900 tokens |

## What it shows

- **Per-caller visibility from one rule.** [`access/rules.ts`](./src/access/rules.ts)
  uses one function, which reads only the principal and the route, as both the
  access rule and the `visible` predicate. A sales reader lists the 80
  read-only tools, sales operations list 180, deletions are listed for nobody,
  and a hidden tool answers exactly like a nonexistent one.
- **Reviewed, pinned annotations.** The team reviewed the vendor's hints, so
  the upstream sets `trustAnnotations: true`; `CRM_CATALOG_PIN` turns any
  later change to a tool or hint into a startup failure.
- **Two endpoints over one gateway engine.** `/mcp` serves the full catalog,
  filtered per caller, for clients that search tools on their own.
  `/search/mcp` serves `search-tools`, `invoke-read-tool`, `invoke-tool`, and
  a two-tool `alwaysList`. Every invocation still runs the target's gateway
  rule.
- **Risk classes.** `invoke-read-tool` accepts only trusted read-only tools,
  so a client can allow it without confirmation; writes go through the
  destructive `invoke-tool`.
- **A host-owned ranker.** The gateway's lexical search does not cross
  languages. [`ranking/portuguese-glossary.ts`](./src/ranking/portuguese-glossary.ts)
  translates Portuguese query terms to the vendor's English vocabulary and
  reuses the gateway's `createSearchIndex`. It can reorder or drop visible
  tools but never reveal one.

| Ten Portuguese queries, such as `cancelar pedido` | recall@8 | Expected tool first |
| --- | --- | --- |
| Lexical search only | 0.0 | 0 of 10 |
| With the glossary ranker | 1.0 | 10 of 10 |

## Layout

```text
src/
  upstreams/crm-engine.ts          # the vendor's 200 tools
  crm-mcp-http.ts                  # the vendor's MCP server, service token only
  access/
    rules.ts                       # one function: access rule and visibility
    api-keys.ts                    # GATEWAY_API_KEYS parsing
  ranking/portuguese-glossary.ts   # host-owned rank port
  gateway.ts                       # composition root: upstream, rules, discovery
  gateway-http.ts                  # /mcp and /search/mcp servers
test/
  discovery.test.ts                # visibility counts, search, recall, risk classes
  gateway-http.test.ts             # both endpoints end to end over MCP
```

## Environment

| Variable | Used by | Meaning |
| --- | --- | --- |
| `CRM_SERVICE_TOKEN` | both processes | Token the vendor server accepts; at least 16 characters |
| `CRM_PORT` | vendor server | Defaults to `3401` |
| `CRM_MCP_URL` | gateway | Defaults to `http://127.0.0.1:3401/mcp` |
| `CRM_CATALOG_PIN` | gateway | Optional catalog fingerprint; the gateway prints the current one at startup |
| `GATEWAY_API_KEYS` | gateway | JSON array of `{ "id", "sha256", "scopes"? }`, with `crm:read` or `crm:write` |
| `DISCOVERY_RANKER` | gateway | `portuguese-glossary` to enable the glossary ranker |

The gateway serves the full catalog at `127.0.0.1:3400/mcp` and discovery at
`127.0.0.1:3402/search/mcp`.

## Run it

From the repository root, build once:

```sh
yarn build
cd examples/gateway-discovery-engine
```

Start the vendor's server in one terminal:

```sh
export CRM_SERVICE_TOKEN="$(openssl rand -hex 24)"
npm run upstream:crm
```

In a second terminal, with the same `CRM_SERVICE_TOKEN`, start the gateway.
The digest below is the SHA-256 of the key; any SHA-256 tool prints it:

```sh
export OPS_KEY="$(openssl rand -hex 24)"
export GATEWAY_API_KEYS="[{\"id\":\"sales-ops\",\"sha256\":\"$(printf '%s' "$OPS_KEY" | sha256sum | cut -d' ' -f1)\",\"scopes\":[\"crm:read\",\"crm:write\"]}]"
DISCOVERY_RANKER=portuguese-glossary npm run gateway
```

Search in Portuguese from a third terminal:

```sh
curl -s -X POST http://127.0.0.1:3402/search/mcp \
  -H "x-api-key: $OPS_KEY" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"gateway_search-tools","arguments":{"query":"cancelar pedido","limit":3}}}'
```

An MCP client connects to either URL and sends the key in the `x-api-key`
header.

## Test

```sh
yarn vitest run examples/gateway-discovery-engine
```

The tests start the vendor server and both gateway endpoints on loopback
ports; nothing leaves the machine.
