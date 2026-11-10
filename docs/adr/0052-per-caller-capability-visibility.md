# ADR 0052: Per-caller capability visibility in adapters

- Status: Accepted
- Date: 2026-11-09

## Context

Every adapter publishes the complete catalog to every caller. `engine.list()`
and `engine.describe()` take no principal (AE-ENG-01), so an authenticated
caller lists, describes, and sees in the OpenAPI document every capability,
including ones whose access rule will always refuse it. For an engine with a
handful of capabilities that is harmless. For a gateway that aggregates
hundreds of upstream tools (ADR 0053), it leaks the existence of operations a
caller cannot use and costs every MCP client tens of thousands of tokens of
irrelevant tools in each conversation.

The HTTP adapters already authenticate each request and the MCP HTTP adapter
already creates one protocol server per request with the snapshotted
principal, so the principal is available exactly where a listing is built.

## Decision

`serveMcpStdio`, `serveMcpHttp`, `createMcpHttpHandler`, `createHttpHandler`,
and `serveHttp` accept an optional `visibility` predicate:

```ts
type CapabilityVisibility = (args: {
  readonly principal: Principal | null;
  readonly capabilityId: string;
}) => boolean;
```

`@invokta/mcp` exports it as `McpCapabilityVisibility` and `@invokta/http` as
`HttpCapabilityVisibility`; the two types are structurally identical, so one
predicate serves every adapter.

- The option is validated as a function before an adapter serves; any other
  value is a `TypeError`.
- The predicate is synchronous and reads only its arguments. It is evaluated
  with the request's snapshotted principal over HTTP. Over stdio it is
  evaluated with the configured principal, cloned once when the server starts;
  a principal that cannot be structured-cloned rejects startup. It receives a
  structured clone frozen recursively through plain objects and arrays, so it
  cannot change the identity that reaches `engine.invoke`; the entries of a
  `Map` or `Set` attribute are copied but not frozen.
- Only a returned `true` makes a capability visible. Any other value,
  including a thrown error and a returned promise, hides it: visibility fails
  closed.
- A hidden capability is indistinguishable from one outside the catalog.
  MCP omits it from `tools/list` and answers `tools/call` with the same
  unknown-tool protocol error. Plain HTTP omits it from `GET /capabilities`,
  answers `GET` and `POST /capabilities/{id}` with the same 404
  `CAPABILITY_NOT_FOUND` before reading the body, and generates
  `GET /openapi.json` from the visible set. Documents are cached by the JSON
  array of visible IDs, which no capability ID can make ambiguous, for at most
  64 distinct sets; when full, the first inserted entry is evicted. No adapter calls `engine.invoke` or emits
  an event for a hidden capability.
- Visibility never grants access. A visible capability still runs its access
  rule on every invocation, so a predicate that is wider than the access rule
  only lists capabilities a call will refuse.
- The core stays unchanged. `list` and `describe` remain principal-free, and
  the MCP catalog preflight and tool-name collision detection always cover the
  complete catalog, so a collision cannot hide behind a narrow predicate.
- Without the option every adapter behaves exactly as before.

An asynchronous predicate is deliberately excluded. Listing 200 capabilities
must cost 200 function calls, not 200 network round trips, and a listing must
not fail because a policy service is slow. Entitlements that need a directory
or a Policy Decision Point are resolved once per request by the `authenticate`
hook, which already performs asynchronous I/O with the request signal, and
carried in `principal.attributes`. The CLI is not covered: its principal is
chosen by the composition root, which can compose a narrower engine. The
devtools emulations do not apply a visibility predicate; they inspect the
complete engine.

## Consequences

- An adapter can show each caller only what its policy could allow, without a
  core change, a new hook, or a second invocation path.
- MCP clients cache tool lists. A change to a caller's attributes appears at
  the client's next `tools/list`; the stateless HTTP profile still sends no
  `notifications/tools/list_changed` (AE-LIMIT-05).
- A predicate that depends on more than the principal and the capability ID,
  such as input, cannot be expressed; such a rule belongs in the access rule.
- Tests cover the Web handler, the `serveMcpHttp` listener, a stdio child
  process compared message by message at the JSON-RPC level, plain HTTP, the
  `serveHttp` forwarding, per-principal OpenAPI with a collision-free key and
  first-inserted eviction, the null principal of a development handler, a
  hidden ID answered before the media-type check without reading the body,
  frozen principals, fail-closed predicates, option validation, and the
  absence of invocation and events for hidden capabilities.
