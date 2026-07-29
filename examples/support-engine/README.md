# Support engine example

This example publishes one domain capability, `support.classify-ticket`, through
the direct API, CLI, MCP stdio, and stateless MCP HTTP. The capability and its
business rules are defined once; every adapter reaches them through
`engine.invoke`.

The example is deterministic and makes no network or model-provider calls. Its
rule-based classifier is an infrastructure adapter that can be replaced by a
model-backed adapter without changing the capability contract.

## Architecture

```text
direct / CLI / MCP stdio / MCP HTTP
                |
                v
           engine.invoke
                |
                v
     support.classify-ticket
       |        |          |
       v        v          v
 repository  classifier  permission checker
```

- `src/application/ports.ts` owns the repository, classifier, and permission
  interfaces.
- `src/capabilities/classify-ticket.ts` owns the stable Zod 4 input/output
  contract, domain access rule, timeout, and handler.
- `src/infrastructure/` contains deterministic adapters for local use.
- `src/engine.ts` is the composition root. Dependencies enter through an
  explicit factory; there is no container or service locator.
- `src/direct.ts`, `src/cli.ts`, `src/mcp-stdio.ts`, and `src/mcp-http.ts` are the
  four inbound entrypoints.

The permission checker is intentionally a domain port. The access rule receives
the validated ticket ID and the trusted `Principal`, then asks for the
`ticket:classify` decision. A denied decision prevents the repository and
classifier from running.

## Run the example

From the repository root, build the framework packages first:

```sh
yarn build
```

Invoke the capability directly:

```sh
node examples/support-engine/dist/direct.js
```

Use the CLI:

```sh
node examples/support-engine/dist/cli.js list
node examples/support-engine/dist/cli.js describe support.classify-ticket
node examples/support-engine/dist/cli.js run support.classify-ticket --input '{"ticketId":"T-123"}'
```

Start the MCP stdio adapter from an MCP host configuration:

```sh
node examples/support-engine/dist/mcp-stdio.js
```

Starting stdio with `node` keeps package-manager status messages out of the MCP
protocol stream.

Start the stateless MCP HTTP adapter on the loopback default:

```sh
SUPPORT_ENGINE_BEARER_TOKEN=development-only-token \
  node examples/support-engine/dist/mcp-http.js
```

The HTTP entrypoint requires a bearer token and never reads identity from the
tool input. Its literal token comparison is only a deterministic demonstration
of the framework's authentication hook. A real deployment must replace it with
the organization's existing IdP library, token introspection, or trusted
identity proxy. The capability-level permission checker remains responsible for
domain authorization.

## Replace the deterministic adapters

Implement `TicketRepository`, `TicketClassifier`, or `PermissionChecker`, then
pass the implementations to `createSupportEngine`. A model-backed classifier
must honor the supplied `AbortSignal`; the runtime also enforces the capability's
30-second timeout. No adapter change is required when these outbound
implementations change.

## Verify the example

```sh
yarn workspace @invokta/example-support test
yarn workspace @invokta/example-support typecheck
yarn workspace @invokta/example-support build
```
