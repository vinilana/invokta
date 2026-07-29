# Composed engine example

This example builds one engine from four sources at once: a local capability,
an atomic capability imported from a package root, a second atomic capability
imported from a package subpath and remapped with `as`, and two capabilities
selected from a capability library with `include` and `remap`.

Every capability, imported or local, reaches the same `engine.invoke` pipeline
and is published through the direct API, the CLI, MCP stdio, and stateless MCP
HTTP under its effective ID.

## The composition

```text
local        operations.generate-report        (this package)
atomic root  community.score-ticket-priority   (default ID kept)
atomic path  operations.classify-ticket        (as: community.classify-ticket)
library      community.search-knowledge-base   (include, default ID kept)
library      operations.draft-reply            (include + remap)
```

`community.classify-ticket` and `community.draft-reply` are **not** engine
capabilities: an effective ID replaces the default ID, it does not alias it.
`community.summarize-thread` is published by the library but never selected, so
it is absent too. All three are rejected with `CAPABILITY_NOT_FOUND` at runtime
and by the type of `invoke` at compile time.

## Architecture

```text
direct / CLI / MCP stdio / MCP HTTP
                |
                v
           engine.invoke
                |
                v
     src/capabilities.ts  (composeCapabilities)
       |            |                |
       v            v                v
  local          atomic imports    library import
  capability     (root, subpath)   (include + remap)
```

- `src/capabilities.ts` is the composition module. It is side-effect free,
  creates no engine, and starts nothing, so `invokta check-capabilities` can
  import it as a build gate.
- `src/engine.ts` imports `capabilities` from that module and calls
  `createEngine`. `createOperationsEngine` recomposes with injected ports for
  tests and alternative deployments.
- `src/application/ports.ts` declares the engine-owned `ReportSource` port and
  aggregates the community package's ports.
- `src/infrastructure/` implements every port deterministically for local use.
- `src/direct.ts`, `src/cli.ts`, `src/mcp-stdio.ts`, and `src/mcp-http.ts` are
  the four inbound entrypoints.

The community package never acquires a dependency by itself. This engine
constructs the repository, classifier, knowledge base, permission checker, and
report source, then hands them to the published factories.

## Run the example

From the repository root, build first:

```sh
yarn build
```

Invoke an atomic and a library capability directly:

```sh
node examples/composed-engine/dist/direct.js
```

```json
{"classification":{"category":"billing","confidence":0.9,"rationale":"The ticket contains language associated with billing."},"reply":{"subject":"Re: Duplicate invoice","body":"Dear customer, We recommend these articles: Requesting a duplicate charge refund, Reading an invoice.","citedArticleIds":["KB-1","KB-3"]}}
```

Use the CLI:

```sh
node examples/composed-engine/dist/cli.js list
node examples/composed-engine/dist/cli.js describe operations.classify-ticket
node examples/composed-engine/dist/cli.js run community.score-ticket-priority \
  --input '{"ticketId":"T-789"}'
node examples/composed-engine/dist/cli.js run operations.draft-reply \
  --input '{"ticketId":"T-123","tone":"friendly"}'
```

Selecting a replaced default ID fails like any unknown capability:

```sh
node examples/composed-engine/dist/cli.js run community.draft-reply \
  --input '{"ticketId":"T-123"}'
```

```json
{"error":{"code":"CAPABILITY_NOT_FOUND","message":"Capability not found.","publicDetails":{"capabilityId":"community.draft-reply"}}}
```

Start the MCP stdio adapter from an MCP host configuration:

```sh
node examples/composed-engine/dist/mcp-stdio.js
```

Start the stateless MCP HTTP adapter on the loopback default:

```sh
COMPOSED_ENGINE_BEARER_TOKEN=development-only-token \
  node examples/composed-engine/dist/mcp-http.js
```

The literal token comparison is a deterministic demonstration of the
authentication hook, not a deployment pattern. A real deployment replaces it
with the organization's IdP library, token introspection, or identity proxy.
Domain authorization stays in each capability's access rule, including the ones
this engine imported.

## Check the composition in CI

```sh
yarn workspace @invokta/example-composed check:capabilities
```

The command imports the built composition module and validates it with the same
rules `composeCapabilities` applies, without starting an adapter. It exits `0`
for a valid composition, `1` for composition issues, and `2` for invalid usage,
a load failure, a missing export, or an untracked raw map.

## Verify the example

```sh
yarn workspace @invokta/example-composed test
yarn workspace @invokta/example-composed typecheck
yarn workspace @invokta/example-composed build
```

[The composition guide](../../docs/capability-composition.md) explains the
authoring and consuming rules this example follows.
