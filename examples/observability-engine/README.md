# Observability engine example

This example publishes one incident-investigation capability backed by Sentry,
Datadog, and New Relic through the direct API, CLI, MCP stdio, and stateless MCP
HTTP:

| Capability | Purpose |
| --- | --- |
| `observability.collect-incident-context` | Collect issues, logs, and service telemetry for one bounded time window |

The capability is defined once; every adapter reaches it through
`engine.invoke`. The public contract describes incident context rather than a
provider API. Sentry, Datadog, and New Relic live behind custom-engine ports and
can be replaced without changing the capability ID, schemas, or entrypoints.

## Architecture

```text
direct / CLI / MCP stdio / MCP HTTP
                |
                v
           engine.invoke
                |
                v
 observability.collect-incident-context
       |              |               |
       v              v               v
 IssueTracker      LogStore     TelemetryReader
       |              |               |
       v              v               v
 Sentry issues   Datadog logs   New Relic NerdGraph
```

- `src/domain/incident-context.ts` owns the normalized request and result types.
- `src/application/ports.ts` owns the three provider-independent ports.
- `src/capabilities/collect-incident-context.ts` owns the stable Zod 4
  contracts, limits, timeout, and handler.
- `src/infrastructure/` is the only layer that knows the external HTTP
  contracts.
- `src/engine.ts` is the composition root; it reads credentials and account
  configuration from the environment and injects the adapters.

The Sentry adapter uses the organization issues endpoint and maps `service` to a
Sentry project slug. The Datadog adapter searches v2 log events with a
`service:<service>` filter. The New Relic adapter runs a fixed, read-only NRQL
aggregate over `Transaction` data where `appName` matches the service. Consumers
cannot submit arbitrary NRQL or provider credentials.

## Configure

```sh
export SENTRY_AUTH_TOKEN='sntrys_...'
export SENTRY_ORG='acme'
export DD_API_KEY='...'
export DD_APP_KEY='...'
export NEW_RELIC_USER_KEY='NRAK-...'
export NEW_RELIC_ACCOUNT_ID='1234567'
```

Optional endpoint overrides support another provider region, a compatible
gateway, or a local test stub:

```sh
export SENTRY_BASE_URL='https://sentry.io'
export DD_BASE_URL='https://api.datadoghq.com'
export NEW_RELIC_GRAPHQL_URL='https://api.newrelic.com/graphql'
```

Use `https://api.eu.newrelic.com/graphql` for a New Relic account in the EU data
center. Every entrypoint fails fast if any required provider setting is missing.
Credentials are never part of the capability input, output, events, or public
error details.

## Run the example

From the repository root, build the framework and example:

```sh
yarn build
```

Invoke the capability directly. The optional fourth argument is the per-provider
result limit:

```sh
node examples/observability-engine/dist/direct.js \
  checkout-api \
  2026-07-28T12:00:00.000Z \
  2026-07-28T13:00:00.000Z \
  20
```

Use the CLI:

```sh
node examples/observability-engine/dist/cli.js list
node examples/observability-engine/dist/cli.js describe observability.collect-incident-context
node examples/observability-engine/dist/cli.js run observability.collect-incident-context --input '{"service":"checkout-api","from":"2026-07-28T12:00:00.000Z","to":"2026-07-28T13:00:00.000Z","limit":20}'
```

Start the MCP stdio adapter from an MCP host configuration:

```sh
node examples/observability-engine/dist/mcp-stdio.js
```

Start authenticated stateless MCP HTTP on the loopback default:

```sh
OBSERVABILITY_ENGINE_BEARER_TOKEN='development-only-token' \
  node examples/observability-engine/dist/mcp-http.js
```

The literal bearer-token comparison is only a deterministic authentication-hook
example. A real deployment replaces it with the organization's identity
implementation. Authorization remains inside `engine.invoke`; the capability
requires an authenticated principal.

## Contract and operational limits

| Concern | Behavior |
| --- | --- |
| Service | 1–128 characters: letters, digits, `_`, `.`, or `-` |
| Time window | Explicit ISO 8601 offsets; start before end; maximum seven days |
| Results | Default 20; range 1–100; enforced locally for issues and logs |
| Provider calls | Sentry, Datadog, and New Relic start concurrently |
| Completion | All-or-nothing; a provider failure aborts its sibling requests |
| Timeout | 30 seconds for the capability invocation |
| Cancellation | The invocation signal reaches all three outbound requests |
| Access | Authenticated, read-only, idempotent, and open-world |

Provider HTTP rejections become `EXECUTION_FAILED` with only `provider` and
`status` in `publicDetails`. Response bodies and credentials remain internal.
The tests use a local three-provider stub and never call public provider APIs.

## Replace a provider

Implement the corresponding custom-engine port and inject it into
`createObservabilityEngine`. The replacement must honor the supplied
`AbortSignal` and return the normalized domain type.

```ts
const engine = createObservabilityEngine({
  issues: myIssueTracker,
  logs: myLogStore,
  telemetry: myTelemetryReader,
});
```

No capability, schema, CLI command, or MCP tool changes.

## Verify the example

```sh
yarn workspace @ai-engine/example-observability test
yarn workspace @ai-engine/example-observability typecheck
yarn workspace @ai-engine/example-observability build
```

Provider contract references:

- [Sentry organization issues API](https://docs.sentry.io/api/events/list-an-organizations-issues/)
- [Datadog v2 log search API](https://docs.datadoghq.com/api/latest/logs/search-logs-post/)
- [New Relic NerdGraph NRQL tutorial](https://docs.newrelic.com/docs/apis/nerdgraph/examples/nerdgraph-nrql-tutorial/)
