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

- `engineUpstream({ name, engine, namespace?, include?, principal?,
  validator? })` reads an in-process engine's catalog once through `list` and
  `describe` and republishes each contract unchanged. Each capability forwards to the
  upstream `engine.invoke` with the request ID, source, mapped principal,
  signal, and progress sink, so the upstream's validation, access rule,
  timeout, and events still apply, and the upstream `timeoutMs` is
  republished. The gateway's timer also covers its own validation and rule,
  so a call near the limit times out at the gateway first. An upstream `DOMAIN_ERROR` is redeclared and raised again as
  the same `CapabilityError`.
- `mcpUpstream({ name, connection, validator, namespace?, include?,
  timeoutMs?, maxTools?, maxToolBytes?, discoveryTimeoutMs?, pin?, lock?,
  trustAnnotations?, readOnlyTools?, forwardToolErrors?, signal? })` lists a
  connected MCP server's tools once, at the composition root, through a
  structural `listTools`/`callTool` interface that `McpClientConnection`
  satisfies. Discovery has one total deadline (30,000 ms by default, at most
  300,000); the deadline and the caller's `signal` settle it even when a client
  ignores the signal. It reads at most
  64 pages and `maxTools` tools (256 by default, at most 4,096), and fails on
  a duplicate name or a schema without an object root. Every published tool
  must have a name of 1 to 128 characters from `A-Z`, `a-z`, `0-9`, `.`,
  `_`, and `-`, and a canonical definition within `maxToolBytes` (65,536 by
  default, at most 1,048,576). Each tool is published as `<namespace>.<tool>`,
  calls the server with a finite timeout (30,000 ms by default) and the
  invocation signal, and returns `structuredContent` when the tool has an
  output schema and `{ content }` otherwise. A tool error is the declared
  domain error `UPSTREAM_TOOL_ERROR` without details: upstream text may hold
  internal details, so its first text block, bounded to 1,024 characters, is
  published only with `forwardToolErrors: true` (AE-CONNECTOR-03).
- Names and namespaces are 1 to 64 lowercase letters, digits, or inner
  hyphens; two upstreams may not share a name or publish the same capability
  ID.

### Validation

Every `mcpUpstream` makes an explicit validation choice: a host-injected,
synchronous `JsonSchemaValidator`, such as Ajv, or `"delegate-to-upstream"`.
With a validator, input is validated against the tool's input schema before
the access rule and the call, failing as `INPUT_INVALID`, so gateway rules
read validated input, and a structured result against the output schema,
failing as `OUTPUT_INVALID`. The same frozen schema object is passed on every
call so validators can cache compiled schemas. A validator that throws or
returns anything but a list or `undefined`, including a promise, fails closed;
a returned promise's rejection is observed so it cannot crash the host. At most
100 issues with 512-character messages reach public details. The validator
receives the caller's value, so mutating validators, such as Ajv with
`useDefaults`, `coerceTypes`, or `removeAdditional`, are not supported. MCP
schemas are chosen by the server: the documented Ajv recipe refuses
asynchronous schemas, and hosts should run `pattern` keywords on a linear-time
regular expression engine or review them through a `lock`.
`"delegate-to-upstream"` names the trade-off: the gateway checks only the
object shape and the lossless JSON model, rules read unvalidated input, and the
server's rejection of invalid input is an `UPSTREAM_TOOL_ERROR`.
`engineUpstream` accepts the same validator optionally; without one, the
upstream `engine.invoke` validates after the gateway rule and its framework
codes pass through. This satisfies AE-SCHEMA-02 through the port or an
explicit delegation; the package bundles no schema library, and a synchronous
validator cannot hold an invocation outside its timeout.

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
- Every pattern of a rule, and every include pattern, must match at least one
  capability, and a rule shadowed by earlier rules fails construction, so a
  typo cannot silently drop part of a rule.
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
their own access rules against the mapped principal, so for them a gateway
can only narrow access. An MCP upstream sees only the gateway's service
credential, so every caller the gateway allows acts with that credential's
authority; the gateway's rules are then the only per-caller control, and the
service credential should carry no more authority than the rules allow.

### Authentication helpers and credentials

Authentication stays the adapters' `authenticate` hook (ADR 0007).
`chainAuthenticators` tries several hooks in order and returns the first
principal other than `null` or `undefined`; a hook that throws stops the
chain, and a request whose signal is aborted stops before the next hook.
`apiKeyAuthenticator` accepts one header (`x-api-key` by default), keeps only
SHA-256 digests in configuration, bounds presented keys to 1,024 characters,
and compares against every digest. `hashApiKey` prints a digest. `requireScopes` reads
`principal.attributes.scopes`, the `@invokta/auth-jwt` default mapping.

The gateway never forwards a caller's credential to an upstream. Each MCP
connection holds the host's service credential; per-caller upstream
credentials remain the connector-broker pattern.

### Audit

`onDecision` receives one frozen decision per authorization: request ID,
capability, upstream, rule, outcome, and principal ID; never input, output, or
credentials. A failing sink is contained. `onDecision` and the discovery's
`onSearch` are package options, not engine hooks: AE-OBS-01 keeps one
cross-cutting hook, `onEvent`, and the gateway engine emits it unchanged.

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
