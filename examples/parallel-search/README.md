# Parallel Search MCP example

Search the web and fetch page excerpts without a Parallel API key through
Invokta's plain MCP client facade. This private consumer connects to
`https://search.parallel.ai/mcp` over Streamable HTTP, discovers the requested
tool, makes one explicit call, prints the MCP tool response as JSON, and closes
the connection. Text excerpts are in the response's `content` array.

This is a client example, not an Action Engine or an autonomous agent loop. It
does not import the MCP SDK directly, register a provider, or change any existing
engine or client configuration.

## Install and run

Use the repository's Node.js 24.20.0 and Yarn 1.22.22 prerequisites. From the
repository root:

```sh
corepack enable
yarn install --frozen-lockfile --non-interactive
yarn build
node examples/parallel-search/dist/main.js search \
  "Find the official MCP TypeScript SDK repository" \
  "official MCP TypeScript SDK repository"
node examples/parallel-search/dist/main.js fetch https://example.com/
```

For search, pass an objective and at least one keyword query. Additional query
arguments are grouped in the same `web_search` call. For fetch, pass one to 20
HTTP or HTTPS URLs to `web_fetch`; URLs containing credentials are rejected.
Fetch uses the server's excerpt defaults rather than requesting full pages.
Tool errors are printed with `isError: true` and exit code 1. Invalid arguments,
missing tools, connection failures, and cancellation also exit with code 1.

No environment keys, saved credentials, or client configuration files are read.
The only custom header is the example's User-Agent. The anonymous service is
[free for exploration and light use](https://docs.parallel.ai/integrations/mcp/search-mcp),
with server-managed rate limits and search settings. This example does not retry
requests or configure authenticated search overrides.

## Execution bounds and validation

Initialization, discovery, and the tool call share a 60-second deadline. Tool
discovery stops after at most 20 pages. The client facade enforces its own 10 MiB
message boundary. The connection is closed on success and failure. Programmatic
callers of `runParallelCommand` may supply an `AbortSignal`; its optional `url`
argument is a test seam for an HTTP MCP fixture, not a CLI setting.

```sh
yarn workspace @invokta/example-parallel-search test
yarn workspace @invokta/example-parallel-search typecheck
yarn workspace @invokta/example-parallel-search build
```

Tests use a local MCP HTTP fixture to check discovery, dispatch, endpoint path,
User-Agent and absence of credentials on actual requests, pagination bounds,
input validation, tool errors, cancellation, and client cleanup. They do not
call the public service. The commands above can be run deliberately against the
public service to verify live search and fetch.
