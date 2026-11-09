# ADR 0053: Action Engine gateway package

- Status: Accepted
- Date: 2026-11-09

## Context

Hosts already publish several Action Engines behind one origin (ADRs 0039 and
0040), and every authentication example repeats the same boundary work (ADR
0049). Consumers that use several engines and MCP servers must install,
authenticate, and authorize each one separately, and nothing lets an operator
apply one policy across them. The gateway design note
([Action Engine gateway](../action-engine-gateway.md)) explored the boundary
with a prototype that was validated end to end over MCP HTTP, MCP stdio, and
plain HTTP JSON, with four runnable examples.

Promoting it touches accepted limits: AE-SCOPE-01 lists every package,
AE-LIMIT-02 excludes remote discovery, AE-LIMIT-04 and the scope matrix
exclude a policy language, AE-SCHEMA-02 requires runtime validation, and
AE-SCOPE-04 asks for repeated evidence. The maintainers decided to promote
the gateway on the strength of the prototype, without waiting for production
deployments; this ADR records that decision and resolves each tension.

## Decision

Invokta publishes `@invokta/gateway`, an optional runtime helper package next
to `@invokta/auth-jwt` and `@invokta/otel`. Its only dependency is
`@invokta/core`; it does not depend on an adapter or the MCP SDK, and its
modules use only ECMAScript and Web platform globals (AE-ARCH-04).

### A capability map, not a runtime

`createGateway({ upstreams, rules?, defaultAccess?, onDecision? })` returns a
frozen `{ capabilities, routes, visibility }`. `capabilities` is an ordinary
capability map that the host passes to `createEngine`, optionally through
`applyMiddleware` or next to engine-local capabilities, and serves with any
adapter. Every call therefore still enters through `engine.invoke`
(AE-ARCH-03); the gateway adds no adapter, transport, error code, event,
context field, or pipeline stage. `routes` lists every published capability
with its upstream, kind, upstream ID, governing rule, and trusted read-only
status. `visibility` is the adapter option of ADR 0052.

### Upstreams

- `engineUpstream({ name, engine, namespace?, include?, principal? })` reads
  an in-process engine's catalog once through `list` and `describe` and
  republishes each contract unchanged. Each capability forwards to the
  upstream `engine.invoke` with the request ID, source, mapped principal,
  signal, and progress sink, so the upstream's validation, access rule,
  timeout, and events still apply. An upstream `DOMAIN_ERROR` is redeclared and
  raised again as the same `CapabilityError`.
- `mcpUpstream({ name, connection, namespace?, include?, timeoutMs?,
  maxTools?, pin?, lock?, trustAnnotations?, readOnlyTools?, validator?,
  signal? })` lists a connected MCP server's tools once, at the composition
  root, through a structural `listTools`/`callTool` interface that
  `McpClientConnection` satisfies. Discovery reads at most 64 pages and
  `maxTools` tools (256 by default, at most 4,096) and fails on a duplicate
  name or a schema without an object root. Each tool is published as
  `<namespace>.<tool>`, calls the server with a finite timeout (30,000 ms by
  default) and the invocation signal, returns `structuredContent` when the
  tool has an output schema and `{ content }` otherwise, and turns a tool
  error into the declared domain error `UPSTREAM_TOOL_ERROR` with the first
  text block bounded to 1,024 characters.
- Names and namespaces are 1 to 64 lowercase letters, digits, or inner
  hyphens; two upstreams may not share a name or publish the same capability
  ID.

### Validation

`mcpUpstream` accepts an optional host-injected `JsonSchemaValidator`. With
it, input is validated against the tool's input schema before the access rule
and the call, failing as `INPUT_INVALID`, and a structured result against the
output schema, failing as `OUTPUT_INVALID`. The same frozen schema object is
passed on every call so validators can cache compiled schemas. A throwing
validator fails closed, and at most 100 issues with 512-character messages
reach public details. Without a validator the gateway checks the object shape
and the lossless JSON model, and the MCP server validates its own input.
Engine upstreams need no validator: the upstream `engine.invoke` validates and
its framework codes pass through. This satisfies AE-SCHEMA-02 by delegation
and, with a validator, at the gateway boundary; the package bundles no schema
library.

### Discovery at startup, locked catalogs

Listing an MCP server's tools at the composition root is explicit
composition, not runtime discovery (AE-LIMIT-02): the host configures every
upstream, awaits discovery before serving, and the catalog is frozen; the
gateway never re-lists tools. `pin` fails startup when the catalog fingerprint
changes. `lock` carries one digest per published tool and fails startup with
`McpCatalogLockError`, whose `added`, `removed`, and `changed` lists name every
difference, so a reviewer reads the change before accepting it.

### Annotation trust

MCP annotations are hints chosen by the server. Without trust, the gateway
republishes only hint values that make a tool look riskier, and a hint alone
never makes a tool read-only. `trustAnnotations: true` trusts every hint of
one upstream, and `readOnlyTools` names tools the operator vouches for. Engine
upstreams are code the host composes, so their annotations are trusted.

### Rules

A rule is `{ name?, match, access, visible? }`. `match` is an exact capability
ID, `prefix.*`, or `*`. `access` is `public`, `authenticated`, `deny`, or a
function of `{ principal, input, context, route }` that allows only on `true`.

- The first matching rule governs a capability, bound once at construction;
  unmatched capabilities get `defaultAccess`, which is `deny` by default.
- A rule or include pattern that matches nothing, and a rule shadowed by
  earlier rules, fails construction.
- A throwing or rejecting access function denies; the decision is reported as
  `failed` and a payload-free warning is logged.
- `visible(principal, route)` is synchronous and never sees input. It
  defaults to the access itself for `public`, `authenticated`, `deny`, and
  `requireScopes`, and to every authenticated caller for other functions.

This is a routing table that assigns an access rule to each capability ID.
Decisions remain core access kinds or host functions that may call any PDP, as
in [capability authorization](../capability-authorization.md); there are no
roles, scopes, conditions, or expressions in the table itself, so it is not
the policy language that AE-LIMIT-04 excludes. Upstream engines still enforce
their own access rules, so a gateway can only narrow access.

### Authentication helpers and credentials

Authentication stays the adapters' `authenticate` hook (ADR 0007).
`chainAuthenticators` tries several hooks in order and returns the first
principal; a hook that throws stops the chain. `apiKeyAuthenticator` accepts
one header (`x-api-key` by default), keeps only SHA-256 digests in
configuration, bounds presented keys to 1,024 characters, and compares against
every digest. `hashApiKey` prints a digest. `requireScopes` reads
`principal.attributes.scopes`, the `@invokta/auth-jwt` default mapping.

The gateway never forwards a caller's credential to an upstream. Each MCP
connection holds the host's service credential; per-caller upstream
credentials remain the connector-broker pattern.

### Audit

`onDecision` receives one frozen decision per authorization: request ID,
capability, upstream, rule, outcome, and principal ID; never input, output, or
credentials. A failing sink is contained. It is a gateway option, not an
engine hook, so AE-OBS-01 is unchanged.

## Consequences

- AE-SCOPE-01 lists fourteen packages, with three optional runtime helpers.
- A gateway is infrastructure, not an Action Engine: it republishes upstream
  domain capabilities under their own IDs or a namespace and owns no domain
  outcome. Maturity level E, a federated platform with registry, tenancy, or
  rollout, remains out of scope.
- Every gateway capability publishes `access: "function"`, because the
  gateway binds its rule and its audit to each capability.
- Limits that remain: a dropped upstream connection fails calls until the
  host reconnects and restarts; rich MCP content of proxied tools without an
  output schema is returned as structured `{ content }`; request IDs are
  shared with engine upstreams for correlation; rules cannot match on
  anything but the capability ID without a function.
- ADR 0054 builds search-based discovery on this package.
