# Crawl engine example

This example publishes three web-crawling capabilities backed by
[Firecrawl](https://docs.firecrawl.dev/) through the direct API, CLI, MCP stdio,
and stateless MCP HTTP:

| Capability | Purpose |
| --- | --- |
| `crawl.scrape-page` | Fetch one public page and return its main content as Markdown |
| `crawl.map-site` | Discover reachable URLs without fetching page content |
| `crawl.crawl-site` | Crawl a bounded number of pages and return their Markdown |

The capabilities are defined once; every adapter reaches them through
`engine.invoke`. Firecrawl is an outbound detail: it lives behind the
`WebCrawler` port and can be replaced without changing a capability contract, an
adapter, or a consumer.

## Architecture

```text
direct / CLI / MCP stdio / MCP HTTP
                |
                v
           engine.invoke
                |
                v
  crawl.scrape-page / map-site / crawl-site
       |                       |
       v                       v
  WebCrawler port      CrawlPermissionChecker
       |
       v
 Firecrawl HTTP adapter (v2 API)
```

- `src/domain/crawl-target.ts` owns the target rule: only public, credential-free
  `http`/`https` addresses are crawlable.
- `src/domain/page.ts` owns the page, link, and crawl result types.
- `src/application/ports.ts` owns the `WebCrawler` and `CrawlPermissionChecker`
  interfaces.
- `src/capabilities/` owns the stable Zod 4 contracts, access rules, timeouts,
  and handlers.
- `src/infrastructure/firecrawl-web-crawler.ts` is the only module that knows the
  Firecrawl HTTP contract.
- `src/engine.ts` is the composition root; it reads the credential from the
  environment and injects the adapters.

## Two boundaries this example demonstrates

**The target rule runs before authorization.** `parseCrawlTarget` rejects
`localhost`, loopback, private, carrier-grade NAT, link-local, multicast,
`.internal`/`.local`/`.home.arpa`, non-HTTP schemes, and URLs carrying
credentials. Because the rule is part of the input schema, a request for
`http://169.254.169.254/latest/meta-data` fails as `INPUT_INVALID` before the
access rule runs and before any outbound request is issued. A crawler capability
that is reachable from an agent, an MCP host, or the network is otherwise a
server-side request forgery primitive.

**Authorization stays in the capability.** The access rule asks
`CrawlPermissionChecker` for the per-capability permission (`crawl:scrape`,
`crawl:map`, `crawl:crawl`) and the host allowlist carried by the trusted
`Principal`. A crawl of an allowed host with the wrong permission is `FORBIDDEN`
without reaching Firecrawl. Identity never comes from the tool input.

The Firecrawl credential is read from the environment by the composition root.
It is never part of a capability contract, never logged, and never included in
`publicDetails`; a provider rejection is reported as `EXECUTION_FAILED` with
`{ "provider": "firecrawl", "status": <http status> }`.

## Configure

```sh
export FIRECRAWL_API_KEY='fc-...'
# Optional: point the adapter at a compatible gateway or a local stub.
export FIRECRAWL_BASE_URL='https://api.firecrawl.dev'
```

Every entrypoint fails fast when `FIRECRAWL_API_KEY` is missing. The bundled
local principal only allows `example.com` and `firecrawl.dev`; edit
`src/local-principal.ts` to crawl other hosts.

## Run the example

From the repository root, build the framework packages first:

```sh
yarn build
```

Invoke the capability directly:

```sh
node examples/crawl-engine/dist/direct.js https://example.com/
```

Use the CLI:

```sh
node examples/crawl-engine/dist/cli.js list
node examples/crawl-engine/dist/cli.js describe crawl.scrape-page
node examples/crawl-engine/dist/cli.js run crawl.scrape-page --input '{"url":"https://example.com/"}'
node examples/crawl-engine/dist/cli.js run crawl.map-site --input '{"url":"https://example.com/","limit":10}'
node examples/crawl-engine/dist/cli.js run crawl.crawl-site --input '{"url":"https://example.com/","limit":5,"maxDepth":2}'
```

Start the MCP stdio adapter from an MCP host configuration:

```sh
node examples/crawl-engine/dist/mcp-stdio.js
```

Starting stdio with `node` keeps package-manager status messages out of the MCP
protocol stream.

Start the stateless MCP HTTP adapter on the loopback default:

```sh
CRAWL_ENGINE_BEARER_TOKEN=development-only-token \
  node examples/crawl-engine/dist/mcp-http.js
```

The HTTP entrypoint requires a bearer token and never reads identity from the
tool input. Its literal token comparison is only a deterministic demonstration
of the framework's authentication hook; a real deployment replaces it with the
organization's identity implementation.

## Bounded execution

| Capability | Timeout | Bound |
| --- | --- | --- |
| `crawl.scrape-page` | 60s | one page |
| `crawl.map-site` | 60s | `limit` links, default 20, maximum 100 |
| `crawl.crawl-site` | 180s | `limit` pages, default 5, maximum 50; `maxDepth` 0–5 |

`crawl.crawl-site` starts an asynchronous Firecrawl job and polls its status.
Polling stops immediately when the invocation is cancelled or when the
capability timeout aborts the signal, and it gives up after a bounded number of
status requests. Pagination targets returned by the provider must share the
configured Firecrawl origin.

## Replace Firecrawl

Implement `WebCrawler` with any provider or an internal crawler and pass it to
`createCrawlEngine`. The implementation must honor the supplied `AbortSignal`.
No capability, schema, adapter, or consumer changes.

```ts
const engine = createCrawlEngine({
  crawler: myCrawler,
  permissions: createAttributeCrawlPermissionChecker(),
});
```

## Verify the example

The tests never reach the public Firecrawl API. A local Firecrawl-compatible
stub server (`test/firecrawl-stub.ts`) serves the adapter and entrypoint tests.

```sh
yarn workspace @invokta/example-crawl test
yarn workspace @invokta/example-crawl typecheck
yarn workspace @invokta/example-crawl build
```
