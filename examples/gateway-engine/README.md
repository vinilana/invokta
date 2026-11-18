# gateway-engine

Serve two Action Engines and one MCP server owned by another team behind one
authenticated gateway, with authorization rules the gateway operator
configures.

> The design rationale is in
> [Action Engine gateway](../../docs/action-engine-gateway.md), and the API
> in the [`@invokta/gateway` reference](https://docs.invokta.dev/reference/gateway/).

## The scenario

Acme's support agents, finance automations, and internal applications need
one endpoint instead of three:

| Upstream | Owner | How the gateway reaches it | Capabilities |
| --- | --- | --- | --- |
| `support` | Support team | In process, `engineUpstream` | `support.classify-ticket`, `support.close-ticket` |
| `billing` | Finance team | In process, `engineUpstream` | `billing.get-invoice`, `billing.refund-invoice` |
| `docs` | Documentation team | Its own MCP server, `mcpUpstream`, with a service token only the gateway holds | `kb.docs_search` |

## What it shows

- **One engine from many upstreams.** `createGateway` returns a capability map;
  `createEngine` turns it into the engine that MCP HTTP and HTTP JSON both
  serve, so every call still goes through `engine.invoke`.
- **Several authentication methods.** `chainAuthenticators` accepts a JWT from
  the identity provider (`@invokta/auth-jwt`) and an API key for automations;
  only SHA-256 digests of the keys are configured.
- **First-match rules, deny by default** in
  [`access/rules.ts`](./src/access/rules.ts): refunds need
  `billing:refund`, other billing calls `billing:read`, support calls
  `support`, and the knowledge base any authenticated caller.
- **Defense in depth.** The gateway lets the `support` scope through, but the
  support engine still requires an agent before closing a ticket.
- **Per-caller visibility.** `gateway.visibility` is passed to both adapters:
  a caller lists only what its rules can allow, and a hidden capability
  answers exactly like a nonexistent one.
- **A pinned, reviewed MCP catalog.** The docs tool's read-only status is
  vouched for with `readOnlyTools`; `DOCS_CATALOG_PIN` makes any change to the
  docs server's tools a startup failure.
- **No token passthrough.** Callers never reach the docs server; the gateway
  uses its own service credential.
- **Audit.** Every authorization decision is one JSON line on stderr, without
  input, output, or credentials.

## Layout

```text
src/
  upstreams/
    support-engine.ts   # support.* with its own agent-only rule
    billing-engine.ts   # billing.* with declared domain errors
    docs-engine.ts      # docs.search, served separately as the remote MCP server
  access/
    rules.ts            # the gateway's first-match rules
    authenticate.ts     # GATEWAY_API_KEYS parsing, optional JWT, the chain
  gateway.ts            # composition root: upstreams, rules, engine
  gateway-http.ts       # MCP HTTP and HTTP JSON servers for the gateway
  docs-mcp-http.ts      # the documentation team's MCP server
  hash-key.ts           # prints the digest of an API key read from stdin
test/
  gateway.test.ts       # routes, rules, defense in depth, visibility, pinning
  authenticate.test.ts  # API keys and a locally signed JWT through one chain
  gateway-http.test.ts  # both servers end to end, over HTTP JSON and MCP
```

## Environment

| Variable | Used by | Meaning |
| --- | --- | --- |
| `DOCS_SERVICE_TOKEN` | both processes | Token the docs server accepts; at least 16 characters |
| `DOCS_PORT` | docs server | Defaults to `3301` |
| `DOCS_MCP_URL` | gateway | Defaults to `http://127.0.0.1:3301/mcp` |
| `DOCS_CATALOG_PIN` | gateway | Optional docs catalog fingerprint; the gateway prints the current one at startup |
| `GATEWAY_API_KEYS` | gateway | JSON array of `{ "id", "sha256", "scopes"?, "agent"? }` |
| `GATEWAY_JWT_ISSUER`, `GATEWAY_JWT_AUDIENCE`, `GATEWAY_JWT_JWKS_URL` | gateway | Optional JWT method; set all three or none |

The gateway listens on `127.0.0.1:3300/mcp` (MCP) and `127.0.0.1:3302`
(HTTP JSON).

## Run it

From the repository root, build once:

```sh
yarn build
cd examples/gateway-engine
```

Start the documentation team's MCP server in one terminal:

```sh
export DOCS_SERVICE_TOKEN="$(openssl rand -hex 24)"
npm run upstream:docs
```

In a second terminal, with the same `DOCS_SERVICE_TOKEN`, create two keys and
start the gateway:

```sh
export AGENT_KEY="$(openssl rand -hex 24)" READER_KEY="$(openssl rand -hex 24)"
export GATEWAY_API_KEYS="[
  {\"id\":\"support-agent\",\"sha256\":\"$(printf '%s' "$AGENT_KEY" | npm run -s hash-key)\",\"scopes\":[\"support\",\"billing:read\"],\"agent\":true},
  {\"id\":\"reader\",\"sha256\":\"$(printf '%s' "$READER_KEY" | npm run -s hash-key)\"}
]"
npm run gateway
```

Try it from a third terminal with the same keys:

```sh
# The reader lists only the knowledge base.
curl -s -H "x-api-key: $READER_KEY" http://127.0.0.1:3302/capabilities

# The agent classifies a ticket.
curl -s -X POST -H "x-api-key: $AGENT_KEY" -H 'content-type: application/json' \
  -d '{"ticketId":"T-1","subject":"Refund for a double charge"}' \
  http://127.0.0.1:3302/capabilities/support.classify-ticket

# Refunds are hidden from the agent: 404, like a capability that does not exist.
curl -s -X POST -H "x-api-key: $AGENT_KEY" -H 'content-type: application/json' \
  -d '{"invoiceId":"INV-1001"}' \
  http://127.0.0.1:3302/capabilities/billing.refund-invoice
```

An MCP client connects to `http://127.0.0.1:3300/mcp` and sends the key in
the `x-api-key` header.

## Test

```sh
yarn vitest run examples/gateway-engine
```

The tests start both servers on loopback ports and sign JWTs with a locally
generated key; nothing leaves the machine.
