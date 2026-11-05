# Scope and limits

## Public packages

**AE-SCOPE-01 — Thirteen packages with isolated roles.** Invokta publishes:

| Package | Responsibility |
| --- | --- |
| `@invokta/core` | Capability and connector authoring contracts, composition, execution, errors, and events |
| `@invokta/cli` | `list`, `describe`, `help`, and `run` with JSON or schema-derived flags over `engine.invoke` |
| `@invokta/mcp` | MCP server adapters and an isolated plain-type client facade over stdio and stateless Streamable HTTP, including a portable Web-standard HTTP handler |
| `@invokta/http` | Web-standard plain HTTP JSON adapter over `engine.invoke`, OpenAPI 3.1 export, and a Node server entry point |
| `@invokta/auth-jwt` | Optional JWT bearer authenticator for one configured issuer, usable as the HTTP `authenticate` hook |
| `@invokta/otel` | Optional OpenTelemetry spans and metrics built from engine events through the OpenTelemetry API |
| `@invokta/tooling` | Development-time validation of capability composition |
| `@invokta/installer` | End-user configuration of supported local MCP clients |
| `@invokta/deploy` | Development-time HTTP engine scaffolding, packaging, health probing, and read-only OAuth discovery inspection |
| `@invokta/devtools` | Development-time engine dev server with per-adapter capability emulation, doctor diagnostics, installed MCP inspection and homologation, and installed CLI inspection and homologation |
| `create-invokta-engine` | Interactive or automated creation of one bounded standalone starter profile, import of one public GitHub example tree, or guided generation from one local OpenAPI 3.1.x contract |
| `create-invokta-capability` | Creation of a standalone atomic capability package |
| `create-invokta-capability-library` | Creation of a standalone capability-library package |

All packages are native ESM. The core has no transport dependency. Runtime
adapters depend only on the core's public API, and supporting applications do
not create another capability execution path. `@invokta/auth-jwt` depends only
on `jose`; no core or adapter package depends on it. `@invokta/otel` depends
only on core types and the `@opentelemetry/api` peer; no other package depends
on OpenTelemetry (ADR 0050).

## Ownership

**AE-SCOPE-02 — Framework.** Invokta provides typed capability and connector
definitions, runtime capability validation, synchronous private connector
configuration validation, eager composition, capability middleware
composition, direct execution, minimal context, access enforcement, events and
their optional OpenTelemetry instrumentation, CLI, MCP, and plain HTTP JSON
adapters, and narrowly scoped supporting tools.

**AE-SCOPE-03 — Custom engine.** Capabilities, prompts, models, engine-owned
ports, outbound connectors for model, data, and tool integrations, business rules,
domain authorization, evals, metrics, and dependency lifecycle belong to the
engine built by the user.

**AE-SCOPE-04 — Evolution by extraction.** New abstractions require repeated
evidence across real engines. They are not added because they may eventually be
useful. The optional connector definition is extracted from repeated network and
filesystem construction boundaries; connector implementations remain engine
owned. The optional JWT bearer authenticator is extracted from the `jose`
verification repeated by nine authentication examples (ADR 0049); identity
providers and token policy beyond one issuer's signed access tokens remain host
owned.

An official example may demonstrate a complete host-owned integration without
making its identity provider, token issuer, persistence, account policy, or
deployment topology a framework runtime abstraction. Production MCP OAuth uses
this boundary: Invokta owns Resource Server conformance and client homologation,
while the example owns one replaceable Authorization Server implementation.

## Explicit limits

| Dimension | Limit |
| --- | --- |
| Framework runtime packages | 4: core, CLI, MCP, and HTTP |
| Supporting packages | 7: tooling, installer, deploy, devtools, and three project creators |
| Optional runtime helper packages | 2: auth-jwt and otel |
| Official inbound adapters | CLI, MCP, and plain HTTP JSON |
| Plain HTTP JSON routes | 4: list, describe, invoke, and OpenAPI document |
| Plain HTTP JSON request body | 1,048,576 bytes by default, configurable |
| MCP transports | stdio and stateless Streamable HTTP |
| MCP HTTP host adapters | 2: a Node.js listener and a Web-standard `Request` handler over one protocol implementation |
| Runtimes verified by tests | Node.js; the core and `@invokta/mcp/web` are portable to Fetch runtimes by design (ADR 0042) |
| Core primitives | Capability, Connector Definition, Engine, Context, and Principal |
| Required capability fields | 5 |
| Invocation pipeline stages | 6 |
| Invocation error codes | 8 framework codes; up to 64 declared domain codes per capability, published inside `DOMAIN_ERROR` |
| Cross-cutting hooks | 1: `onEvent`; capability middleware is composed into `run`, not registered (ADR 0051) |
| OpenTelemetry signals | 1 span per invocation and 3 metric instruments |
| Pending OpenTelemetry invocation spans | 10,000 by default, configurable; the oldest is evicted, and the same cap bounds evicted-invocation bookkeeping |
| OpenTelemetry attribute values | 256 characters on spans and metrics; 256 distinct per metric attribute by default, configurable |
| Auth or PDP implementations | 1: the opt-in `@invokta/auth-jwt` JWT bearer authenticator; no PDP |
| Containers or runtime plugin systems | 0 |
| Devtools workbenches served together | 2: MCP and CLI, each idle until Connect |
| Concurrent attached devtools targets | 1 per workbench |
| Concurrent attached devtools tool calls or CLI verbs | 1, explicitly initiated |
| Concurrent devtools adapter emulations | 4, each in its own process |
| Devtools playground HTTP targets | 1: the devtools host or one external endpoint |
| Devtools playground entry points | 1 per adapter: the devtools child or one project entry inside the served directory |
| OpenAPI import input | 1 local OpenAPI 3.1.x JSON or YAML entry document |
| OpenAPI import aggregate bytes and documents | 10 MiB and 64 local documents |
| OpenAPI import operations | 500 discovered, 100 eligible, and 100 selected/generated |
| OpenAPI import parsed nodes | 100,000; YAML aliases are rejected |
| OpenAPI reference-resolution work units | 100,000 |
| OpenAPI import document/reference/schema depth | 64 |
| OpenAPI import schema nodes | 1,000 reachable by one operation |
| Generated OpenAPI TypeScript module basename | 64 ASCII characters |
| Generated OpenAPI runtime URL | 8,192 UTF-8 bytes |
| Generated OpenAPI runtime request body | 10 MiB serialized JSON |
| Generated OpenAPI runtime response body | 10 MiB streamed bytes |
| CLI flag spelling | 64 characters; reserved `input`, `stdin`, `help`, and `format` |
| CLI capability help page | 100 flag or input-only entries, 20 allowed values per flag, and 500 characters per text field |
| JWT bearer token length | 8,192 characters by default; at most 16,384 |
| JWT bearer clock tolerance | 0 seconds by default; at most 300 |
| JWT bearer remote JWKS | 5-second fetch timeout, 10-minute cache, 30-second unknown-key refetch cooldown after a successful fetch, 5-second no-fetch window on the monotonic clock after a failed fetch, no redirects, response size bounded only by the timeout |
| JWT bearer candidate keys for a token without `kid` | 8 signature checks per token |

**AE-LIMIT-01 — Runtime.** Invokta does not provide universal lifecycle,
queues, concurrency control, automatic retries, distributed execution, jobs,
scheduling, arbitrary streaming, or a progress API.

**AE-LIMIT-02 — Architecture.** Invokta does not provide a dependency
container, service locator, runtime plugin discovery, remote registry, or
mutable module lifecycle. Capability composition is explicit, eager, and based
on values imported by the application. Capability middleware is a pure function
the application applies to an explicit capability map; the engine does not
register, discover, or order it.

**AE-LIMIT-03 — AI and quality.** Invokta does not provide a model router,
context compiler, memory, RAG abstraction, prompt registry, official provider
connectors or connector catalog, connector lifecycle, semantic cache, economics
engine, eval runner, automated judge,
release gate, or canary platform.

**AE-LIMIT-04 — Security.** Invokta does not provide an identity provider,
token issuer, token introspection client, OpenID Connect discovery, DPoP, mTLS,
policy language, relationship graph, PDP adapter, or session binding. The
optional `@invokta/auth-jwt` package verifies signed JWT bearer access tokens
from one configured issuer against an explicit JWKS URL or local key set; it
does not accept opaque, encrypted, or shared-secret tokens, several issuers,
or sender-constrained tokens, and it is not a universal token verifier.

**AE-LIMIT-05 — MCP.** Invokta does not provide MCP resources, prompts,
sampling, elicitation, tasks, stateful sessions, resumption, or server-to-client
requests.

**AE-LIMIT-06 — Installed MCP inspection.** Devtools may initialize, list tools
from, and manually call one explicitly configured stdio or Streamable HTTP MCP
target. For an interactive HTTP target it may complete one ephemeral OAuth
Authorization Code with PKCE flow through the isolated official SDK. It does
not discover or import installations, persist connections or credentials,
connect multiple targets, invoke automatically, retry a connected tool call,
evaluate, judge, certify, or gate a release. Workspace-only Doctor, principals,
watch, core events, and `engine.invoke` trace claims do not apply to an attached
external target.

**AE-LIMIT-07 — Installed CLI inspection.** Devtools may spawn one
explicitly configured executable with `shell: false` and run `list`,
`describe`, and one explicit `run` against that target, using only the
published CLI verbs and `--input`. It does not discover or import
installations, persist connections or credentials, connect multiple
targets, invoke automatically, retry a verb, evaluate, judge, certify, or
gate a release. It does not pass `--stdin`, `--format`, actor flags, or
login flags. Workspace-only Doctor, principals, watch, core events, and
`engine.invoke` trace claims do not apply to an attached CLI target.
`verify --cli` is out of scope. Both workbenches are served together from one
loopback origin and each keeps its own browser session, so a session for one
never authorizes the other and switching between them carries no target,
connection, or activity across.

**AE-LIMIT-08 — Guided OpenAPI import.** The engine creator may parse one
explicit local OpenAPI 3.1.x JSON or YAML contract, resolve bounded local
references contained by its directory, display a bounded operation catalog,
and generate selected operation wrappers, narrow ports, and one engine-owned
typed outbound connector.
It does not fetch remote contracts or references, invoke an operation, read or
copy credentials, interpret OpenAPI at runtime, acquire OAuth tokens, generate
multipart or binary clients, or claim that an API mirror is a qualified domain
Action Engine. Unsupported endpoints remain visible and unselected. Generated
adapters continue to use the one shared engine and `engine.invoke` path.

**AE-LIMIT-09 — Observability.** `@invokta/otel` translates the three engine
events into spans and metrics through the OpenTelemetry API. Invokta does not
provide an OpenTelemetry SDK, exporter, collector, sampler, log signal,
dashboard, alerting, telemetry storage, or automatic trace-context propagation
into `access` or `run`. Capabilities nest their own spans only through the
injected `contextFor` accessor defined by ADR 0050.

## Evolution triggers

An extension requires evidence and an architectural decision. Examples include
authentication support after several engines repeat the same integration, a
PDP adapter after multiple engines repeat one provider mapping, lifecycle only
when dependency start and stop behavior repeats, and observability or evaluation
packages only when engine-local implementations converge. ADR 0050 records
that extraction for OpenTelemetry instrumentation of engine events.
